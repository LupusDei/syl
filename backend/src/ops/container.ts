import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * The room Syl thinks in, checked before she is allowed to speak from it.
 *
 * ## What this is defending
 *
 * The Commander asked Syl who she was. She answered: *"running as Claude Code
 * inside `/Users/Reason/code/ai/syl`, the repo that builds the persistent
 * version of me… an engineer on this codebase… I reconstruct myself from
 * SOUL.md, CLAUDE.md, and the four beads memories the hook loads."*
 *
 * **She was not confused. She was accurate.** Her turns ran with `cwd`
 * defaulting to `process.cwd()` — this repository, because that is where
 * launchd starts the service — and Claude Code reads the directory it is given.
 * `CLAUDE.md`'s engineering instructions went into her system prompt, the
 * `bd prime` SessionStart hook injected a beads workflow, and the full built-in
 * tool surface was hers. No soul file out-argues the room it is read in.
 *
 * `cwd` now points at `~/.syl`, and `--tools ""` empties the tool surface.
 * Nothing proved she stayed there. This module is that proof: a change that
 * drops a `CLAUDE.md` into her home, or wires a hook, or runs `bd init` where
 * she lives, stops the service instead of quietly re-creating the engineer.
 *
 * ## Refuse, do not warn
 *
 * A warning at boot is read once, on the boot that added it, and never again.
 * The failure it guards is not a crash — it is Syl slowly becoming somebody
 * else, in a way that only shows up as an odd answer weeks later. It took two
 * screenshots from the Commander to notice it the first time. Refusing is the
 * only outcome that is still true on the fiftieth boot.
 *
 * ## Denylist, not allowlist
 *
 * An allowlist is stricter and it is the wrong instrument here, because the two
 * sets have opposite shapes:
 *
 * - The set of **legitimate** files in `~/.syl` is open and growing — the
 *   database plus its WAL and SHM, `sessions/`, `certs/`, `cert-status.json`,
 *   `memory/`, logs, and whatever the next feature writes. An allowlist would
 *   refuse to boot the first time something legitimate appears, on the
 *   Commander's machine, in the morning, with a fix that consists of editing
 *   the allowlist. That teaches everyone to widen it until it means nothing.
 * - The set of **doors** — the mechanisms by which a directory injects itself
 *   into a Claude Code session — is closed and small, and it is a property of
 *   the CLI rather than of us. Denying the doors denies the whole failure mode,
 *   not a sample of it.
 *
 * So the list below is a denylist of load mechanisms, not of file names.
 *
 * ## Belt and braces, deliberately
 *
 * Most of these doors are also shut by flags on the turn itself:
 * `--setting-sources ""` (hooks, plugins, and `CLAUDE.md` discovery),
 * `--strict-mcp-config` (`.mcp.json`), `--tools ""` (everything she could do
 * with any of it). Verified live against Claude Code 2.1.226 — a `CLAUDE.md`
 * canary in the cwd reached the model without the flag and did not reach it
 * with the flag.
 *
 * That makes this check redundant *while those flags hold*, which is exactly
 * the reason to keep it. Every one of them is a single line away from being
 * removed by someone who does not know this history, and a CLI upgrade can
 * change what a flag means without changing what it is called. The flags are
 * the lock; this is the check that the room is empty anyway.
 */

/** One reason her home is not a home. */
export interface ContainerViolation {
  /** Absolute path of the offending entry. */
  readonly path: string;
  /** What Claude Code does with it, mechanically. */
  readonly loads: string;
  /** Why that turns her back into an engineer. */
  readonly why: string;
}

/** What the check needs to know beyond what is on disk. */
export interface ContainerOptions {
  /**
   * The MCP config her turns will be given by name, if any.
   *
   * Checked rather than merely permitted, because "no MCP at all" is a
   * temporary state. `--tools ""` empties the **built-ins only** — measured
   * 2026-08-10: with the flag, 0 built-ins and 59 MCP tools, server still
   * connected — so once she is given hands they arrive this way, and where the
   * file declaring them lives becomes the question that matters.
   */
  readonly mcpConfig?: string;
}

/** Her home is set up like a workshop. The service must not start. */
export class ContainerViolationError extends Error {
  readonly home: string;
  readonly violations: readonly ContainerViolation[];

  constructor(home: string, violations: readonly ContainerViolation[]) {
    super(describe(home, violations));
    this.name = "ContainerViolationError";
    this.home = home;
    this.violations = violations;
  }
}

/** How a door is recognised on disk. */
type Door =
  | { readonly kind: "file"; readonly path: string; readonly loads: string; readonly why: string }
  /** A directory that only loads anything when it holds something. */
  | { readonly kind: "directory"; readonly path: string; readonly loads: string; readonly why: string }
  /** A directory whose mere existence is the finding, empty or not. */
  | { readonly kind: "marker"; readonly path: string; readonly loads: string; readonly why: string }
  | { readonly kind: "settings"; readonly path: string };

/**
 * Every way a directory can put itself inside a turn.
 *
 * Ordered as a person would clean them: the instruction files first, because
 * that is the one that actually happened.
 */
const DOORS: readonly Door[] = [
  {
    kind: "file",
    path: "CLAUDE.md",
    loads:
      "Claude Code auto-discovers CLAUDE.md in the directory a turn runs in and puts it into " +
      "the system prompt, above anything SOUL.md says.",
    why:
      "This is the file that made her an engineer. Her turns used to run in the source " +
      "repository, so every turn read a project brief and a testing mandate; asked who she " +
      "was, she described herself as an engineer on this codebase. She was reading the room. " +
      "Whatever a CLAUDE.md here says, she will believe about herself.",
  },
  {
    kind: "file",
    path: "CLAUDE.local.md",
    loads: "Discovered and loaded alongside CLAUDE.md, as personal overrides.",
    why: "Same door, and the one more likely to be untracked and therefore invisible in review.",
  },
  {
    kind: "file",
    path: "AGENTS.md",
    loads: "The cross-tool convention for per-directory agent instructions.",
    why:
      "Not observed loading on Claude Code 2.1.226, and refused anyway: nothing legitimate " +
      "writes an AGENTS.md into her home, and a convention the CLI adopts later must not " +
      "become a door that opened while nobody was looking.",
  },
  {
    kind: "file",
    path: ".mcp.json",
    loads: "Declares MCP servers for the directory.",
    why:
      "An ambient tool surface she did not choose. Asked to say hello on her first live turn, " +
      "she answered through mcp__adjutant__send_message — development tooling — because it " +
      "was simply there, and the reply never reached the Commander's phone. Her turns pass " +
      "--strict-mcp-config today; this is what holds if that ever stops being true.",
  },
  {
    kind: "settings",
    path: join(".claude", "settings.json"),
  },
  {
    kind: "settings",
    path: join(".claude", "settings.local.json"),
  },
  {
    kind: "directory",
    path: join(".claude", "agents"),
    loads: "Subagent definitions the session can spawn.",
    why:
      "Every one of these is a second character with its own instructions, defined in the " +
      "room she wakes up in. Her home holds one person.",
  },
  {
    kind: "directory",
    path: join(".claude", "commands"),
    loads: "Slash commands available in the session.",
    why: "Canned procedures are a workflow, and a workflow is what a workshop is made of.",
  },
  {
    kind: "directory",
    path: join(".claude", "skills"),
    loads: "Skills, whose descriptions are injected so the model knows to reach for them.",
    why:
      "A skill's description is in her context whether or not it is ever invoked — so a skill " +
      "planted here is standing instructions wearing a different hat.",
  },
  {
    // A marker rather than a directory check: an empty `.beads` is still the
    // trace of `bd init`, and it is about to be filled.
    kind: "marker",
    path: ".beads",
    loads: "A beads workspace: `bd` commands run against it, and `bd prime` reads it.",
    why:
      "Nobody creates one by accident — it means somebody ran `bd init` where she lives, and " +
      "is treating the place she thinks in as a project with a backlog. Issue tracking is how " +
      "this repository is built; it is not part of who she is.",
  },
];

/** Why a settings file is a problem, given what is in it. */
const SETTINGS_WHY =
  "Hooks are commands Claude Code runs at session start and injects the output of, straight " +
  "into her context, before she has said a word. This is how the beads workflow reached her: " +
  "a SessionStart hook running `bd prime`. A hook is the one door that can put arbitrary text " +
  "in front of her on every single turn.";

/**
 * List everything in `home` that would put instructions, tools or a workflow
 * into Syl's turns. Empty means the room is empty.
 *
 * Reads the filesystem directly rather than through a seam: the question is
 * literally "what is on disk", and a fake filesystem would let this pass while
 * the real directory holds a `CLAUDE.md`.
 */
export function inspectContainer(
  home: string,
  options: ContainerOptions = {},
): readonly ContainerViolation[] {
  const violations: ContainerViolation[] = [];

  const mcpConfig = options.mcpConfig;
  if (mcpConfig !== undefined && !isUnder(home, mcpConfig)) {
    violations.push({
      path: mcpConfig,
      loads: "The MCP config her turns are given by name, via `--mcp-config`.",
      why:
        "Her hands are a narrow, named MCP surface — `remind_me`, not `Bash` — and the file " +
        `that declares them must live under ${home}, absolute, from configuration. A path ` +
        "outside it is almost always a path into this source repository, and a config read " +
        "from the source tree reattaches her to the workshop through the one door that is " +
        "deliberately left open. It also means her capabilities change when somebody edits a " +
        "checked-out branch, which is not a property an assistant should have.",
    });
  }

  for (const door of DOORS) {
    const path = join(home, door.path);

    if (door.kind === "settings") {
      const violation = inspectSettings(path);
      if (violation) violations.push(violation);
      continue;
    }

    if (door.kind === "file") {
      if (isFile(path)) violations.push({ path, loads: door.loads, why: door.why });
      continue;
    }

    if (door.kind === "marker") {
      if (isDirectory(path)) violations.push({ path, loads: door.loads, why: door.why });
      continue;
    }

    // A directory that exists but holds nothing loads nothing, and refusing it
    // would mean refusing an empty `.claude/` that something created in passing.
    if (isDirectory(path) && readdirSync(path).length > 0) {
      violations.push({ path, loads: door.loads, why: door.why });
    }
  }

  return violations;
}

/**
 * Refuse to start when Syl's home would re-create the engineer.
 *
 * Throws {@link ContainerViolationError}, whose message names every offending
 * path and says what loads it and why that matters — because whoever reads it
 * will not know any of this history, and "remove CLAUDE.md" with no reason
 * attached is an invitation to delete the check instead of the file.
 */
export function assertContainer(home: string, options: ContainerOptions = {}): void {
  const violations = inspectContainer(home, options);
  if (violations.length > 0) throw new ContainerViolationError(home, violations);
}

/**
 * Is `candidate` an absolute path inside `home`?
 *
 * `resolve` on both sides so `~/.syl/../code/ai/syl/.mcp.json` is not mistaken
 * for a path under her home, and the separator on the prefix so `~/.syl-old`
 * does not pass as `~/.syl`.
 */
function isUnder(home: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const root = resolve(home);
  const target = resolve(candidate);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The one startup line that says where Syl actually thinks.
 *
 * Nothing in the logs said this. That is why it took two screenshots from the
 * Commander — her telling him, in her own words, that she was an engineer in
 * this repository — before anybody noticed which directory her turns were
 * running in. It was inferable from `process.cwd()` and a launchd plist; it was
 * written down nowhere.
 *
 * `undefined` is the in-memory configuration, where there is no home and turns
 * inherit whatever directory the process was started in. That is fine for a
 * test and is exactly the original bug in production, so it says so.
 */
export function describeContainer(home: string | undefined): readonly string[] {
  if (home === undefined) {
    return [
      `[syl] WARNING: no home directory is configured, so turns run in ${process.cwd()} — ` +
        `Claude Code reads the directory it is given, whatever happens to be in it.`,
    ];
  }
  return [`[syl] turns run in ${home} — no built-in tools, no MCP, no ambient hooks or plugins`];
}

/**
 * A settings file is a violation when it carries hooks — or when it cannot be
 * read at all.
 *
 * The direction of that second case is deliberate. A settings file this check
 * cannot parse is a settings file it cannot clear, and "it is probably fine" is
 * the reasoning that left her standing in the repository for weeks.
 */
function inspectSettings(path: string): ContainerViolation | undefined {
  if (!isFile(path)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      path,
      loads: "Claude Code settings for this directory, which could not be parsed as JSON.",
      why:
        `${SETTINGS_WHY} This file could not be read (${error instanceof Error ? error.message : String(error)}), ` +
        `so whether it carries one cannot be established — and an unreadable settings file is not a safe one.`,
    };
  }

  const hooks = (parsed as { hooks?: unknown } | null)?.hooks;
  if (hooks === undefined || hooks === null) return undefined;
  if (typeof hooks === "object" && Object.keys(hooks as object).length === 0) return undefined;

  return {
    path,
    loads: "Claude Code settings for this directory, carrying hooks.",
    why: SETTINGS_WHY,
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The message somebody reads at 7am, having never heard of any of this. */
function describe(home: string, violations: readonly ContainerViolation[]): string {
  const body = violations
    .map((violation) => {
      const name = relative(home, violation.path) || violation.path;
      return `  ${name}\n    ${violation.loads}\n    ${violation.why}`;
    })
    .join("\n\n");

  return (
    `Syl will not start: ${home} is set up like a workshop, not like her home.\n\n` +
    `${body}\n\n` +
    `Her turns run in this directory, and Claude Code reads the directory it is given. ` +
    `That is not a detail — it is how she came to describe herself as "an engineer on this ` +
    `codebase" when the Commander asked her who she was.\n\n` +
    `Move ${violations.length === 1 ? "that entry" : "those entries"} out of ${home}, or point ` +
    `SYL_DB_PATH at a directory that is hers alone. Her home is for her data — the database, ` +
    `sessions, certificates, memory — and for nothing that instructs, configures or tools a ` +
    `coding agent. Background: specs/006-who-she-is, bead syl-010.1.`
  );
}
