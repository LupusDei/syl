import { execFileSync } from "node:child_process";

/**
 * Whether the machine underneath Syl is configured to stay awake and to come
 * back on its own.
 *
 * Two settings decide whether an unattended assistant is possible at all, and
 * neither of them is software we control:
 *
 * - `sleep 0` — a sleeping Mac fires no reminders. The scheduler wakes up late
 *   and the 07:00 agenda arrives whenever somebody touches the trackpad.
 * - `autorestart 1` — after a power cut the machine stays **off** until a human
 *   presses the button. No amount of `KeepAlive` handles that; there is nothing
 *   running to keep alive.
 *
 * Setting them needs `sudo`, so it is the Commander's action. Checking them
 * does not, so it is ours — and it belongs at startup rather than in a runbook,
 * because the failure it prevents is a *reset*: an OS update, a migration
 * assistant, a new machine, and the settings are back to defaults with nothing
 * to say so. The service is the only thing that runs after all of those.
 *
 * `degraded`, never `down`. A Mac configured to sleep still serves every
 * request it is awake for, and refusing to start would trade a partial outage
 * for a total one.
 */

/** The `pmset` settings this cares about, and what each must be. */
export const REQUIRED_POWER_SETTINGS: Readonly<Record<string, string>> = {
  sleep: "0",
  autorestart: "1",
};

/** What `pmset -g custom` reported for one power source. */
export interface PowerSettings {
  readonly source: string;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Parse `pmset -g custom`.
 *
 * The real format, captured from the Commander's machine:
 *
 * ```
 * AC Power:
 *  sleep                15 (sleep prevented by caffeinate, coreaudiod)
 *  autorestart          0
 * Battery Power:
 *  sleep                1
 * ```
 *
 * Two details that a naive split gets wrong, and both appear in that sample:
 * the parenthetical suffix on `sleep`, and the fact that the settings that
 * matter live under `AC Power` — a Mac mini on a desk has no battery section at
 * all, and a laptop has both with different values.
 */
export function parsePmset(output: string): readonly PowerSettings[] {
  const sections: { source: string; values: Record<string, string> }[] = [];
  for (const rawLine of output.split("\n")) {
    if (rawLine.trim() === "") continue;
    // A section header is flush left and ends in a colon.
    if (!/^\s/.test(rawLine)) {
      const source = rawLine.trim().replace(/:$/, "");
      sections.push({ source, values: {} });
      continue;
    }
    const current = sections[sections.length - 1];
    if (current === undefined) continue;
    // `Sleep On Power Button 1` has spaces in its name, so the *last* token is
    // the value and everything before it is the key. The parenthetical, when
    // there is one, comes after that value and is dropped.
    const line = rawLine.trim().replace(/\s*\(.*\)\s*$/, "");
    const match = /^(.*?)\s+(\S+)$/.exec(line);
    if (match === null) continue;
    const [, key, value] = match;
    if (key === undefined || value === undefined) continue;
    current.values[key] = value;
  }
  return sections;
}

/**
 * The section that decides whether Syl runs overnight.
 *
 * `AC Power` when there is one, because the machine Syl lives on is plugged in;
 * otherwise whatever single section the platform reported, which is what
 * `pmset -g` gives on a desktop.
 */
export function acPower(sections: readonly PowerSettings[]): PowerSettings | null {
  const ac = sections.find((section) => /^AC Power$/i.test(section.source));
  if (ac !== undefined) return ac;
  // The first section *with settings in it*, not simply the first. `pmset -g`
  // opens with two flush-left lines — "System-wide power settings:" and
  // "Currently in use:" — and only the second has anything under it. Taking
  // `sections[0]` there reported "pmset did not tell us about sleep" on a
  // machine that had just said `sleep 15`.
  return sections.find((section) => Object.keys(section.values).length > 0) ?? null;
}

/** Everything wrong with the machine's power configuration, in an operator's words. */
export function powerProblems(settings: PowerSettings | null): readonly string[] {
  if (settings === null) return ["pmset reported nothing this service could read."];

  const problems: string[] = [];
  for (const [key, required] of Object.entries(REQUIRED_POWER_SETTINGS)) {
    const actual = settings.values[key];
    if (actual === undefined) {
      problems.push(`pmset did not report ${key} for ${settings.source}.`);
      continue;
    }
    if (actual === required) continue;
    problems.push(
      key === "sleep"
        ? `${settings.source} sleep is ${actual}, not 0. A sleeping Mac fires no reminders. ` +
          `Fix with: sudo pmset -c sleep 0`
        : `${settings.source} autorestart is ${actual}, not 1. After a power cut this machine ` +
          `stays off until somebody presses the button. Fix with: sudo pmset -c autorestart 1`,
    );
  }
  return problems;
}

/** How the `pmset` output is obtained. Injectable, so the parse is testable. */
export type PmsetReader = () => string;

/**
 * Ask the real `pmset`.
 *
 * Throws nothing a caller has to handle: a machine that is not a Mac, or a
 * `pmset` that is missing, returns `null` and the check reports that rather
 * than taking the service down over a diagnostic.
 */
export const systemPmset: PmsetReader = () =>
  execFileSync("/usr/bin/pmset", ["-g", "custom"], { encoding: "utf8", timeout: 5_000 });

export interface PowerAssessment {
  /** `true` when the machine will stay awake and come back by itself. */
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** `false` when this platform has no `pmset` to ask. */
  readonly checked: boolean;
}

/** Check the machine, tolerating every way that check can fail to happen. */
export function assessPower(
  options: { readonly platform?: string; readonly read?: PmsetReader } = {},
): PowerAssessment {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { ok: true, checked: false, problems: [] };
  }
  let output: string;
  try {
    output = (options.read ?? systemPmset)();
  } catch (error) {
    return {
      ok: false,
      checked: false,
      problems: [`pmset could not be read: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const problems = powerProblems(acPower(parsePmset(output)));
  return { ok: problems.length === 0, checked: true, problems };
}

/** The lines to print about the machine's power configuration. */
export function describePower(assessment: PowerAssessment): readonly string[] {
  if (!assessment.checked && assessment.problems.length === 0) return [];
  if (assessment.ok) return ["[syl] power: this Mac will not sleep and restarts after a power cut"];
  return assessment.problems.map(
    (problem) => `[syl] WARNING: ${problem}`,
  );
}
