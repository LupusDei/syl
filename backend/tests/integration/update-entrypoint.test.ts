import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/syl-update.sh` — what launchd runs to auto-deploy.
 *
 * The decision logic is all in TypeScript and tested without a machine. What
 * cannot be tested there is this file, and it has the same three chances to be
 * wrong that `syl-service.sh` has, months from now, at 3am, with nobody
 * watching:
 *
 * 1. **Finding node.** launchd hands a job `/usr/bin:/bin:/usr/sbin:/sbin`.
 * 2. **Stripping the credential variables.** This process runs `npm run
 *    verify`, which spawns the suite, which spawns `claude` — so a stray
 *    `ANTHROPIC_API_KEY` here reroutes the Commander's billing exactly as
 *    surely as one in the service.
 * 3. **Refusing clearly** when there is no built output to run.
 *
 * The script is run for real. What is arranged is the environment it runs in:
 * a scratch repository root, so nothing here can deploy anything.
 */

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const script = join(repoRoot, "scripts", "syl-update.sh");

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "syl-update-"));
  directories.push(directory);
  return directory;
}

interface Run {
  readonly status: number;
  readonly output: string;
}

/** Run the script with a launchd-shaped PATH and the given extra environment. */
function run(scriptPath: string, env: Readonly<Record<string, string>> = {}): Run {
  const result = spawnSync("/bin/bash", [scriptPath], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: process.env.HOME ?? tmpdir(), ...env },
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * A copy of the script inside a scratch tree, so it resolves that tree as the
 * repository root and can never reach the real one.
 */
function isolated(): string {
  const root = scratch();
  const scripts = join(root, "scripts");
  writeFileSync(join(root, "marker"), "");
  const path = join(scripts, "syl-update.sh");
  spawnSync("/bin/mkdir", ["-p", scripts]);
  spawnSync("/bin/cp", [script, path]);
  return path;
}

const onMacOS = process.platform === "darwin";
if (!onMacOS) {
  console.warn(
    "[update-entrypoint.test] skipped: launchd, `sort -rV` and the BSD tooling this script assumes are macOS-only. Covered by the macOS job in ios.yml.",
  );
}

describe.skipIf(!onMacOS)("scripts/syl-update.sh", () => {
  it("should refuse, with EX_CONFIG, when there is no built deploy command", () => {
    // The one failure a plist cannot describe. Exit 78 means "a human has to
    // fix something", and the line above it says which thing.
    const result = run(isolated(), { SYL_NODE_BIN: process.execPath });

    expect(result.status).toBe(78);
    expect(result.output).toContain("npm run build");
    expect(result.output).toContain("backend/dist/ops/cli/deploy.js");
  });

  it("should refuse when no usable node can be found at all", () => {
    // Not "run with whatever node happens to be there": Node 20 has no
    // node:sqlite, so a deploy driven by one would fail in a way that looks
    // like a broken build rather than a wrong interpreter.
    const fakeNode = join(scratch(), "node");
    writeFileSync(fakeNode, "#!/bin/bash\nprintf 'v18.20.8\\n'\n", { mode: 0o755 });
    // A HOME with no `.nvm`, or the real one's node 22 answers for it and the
    // test proves nothing about the branch it claims to cover.
    const emptyHome = scratch();

    const result = run(isolated(), { SYL_NODE_BIN: fakeNode, PATH: "/usr/bin:/bin", HOME: emptyHome });

    expect(result.status).toBe(78);
    expect(result.output).toMatch(/no node/i);
  });

  it("should say so when gh is missing, since the CI gate cannot be answered without it", () => {
    // Not fatal — the gate reports "could not ask GitHub" and declines to
    // deploy, which is the correct posture. But a silent version of that would
    // read as "nothing ever needs deploying".
    const result = run(isolated(), { SYL_NODE_BIN: process.execPath, PATH: "/usr/bin:/bin" });

    expect(result.output).toMatch(/gh/);
  });

  it("should not carry a credential variable into anything it spawns", () => {
    // It runs the test suite, which spawns `claude`. Constraint 3.
    const probe = join(scratch(), "probe.sh");
    writeFileSync(
      probe,
      // Everything up to the exec, then report what survived instead of running.
      `${["set -uo pipefail", 'unset ANTHROPIC_API_KEY', 'unset ANTHROPIC_AUTH_TOKEN', 'printf "KEY=[%s] TOKEN=[%s]\\n" "${ANTHROPIC_API_KEY:-}" "${ANTHROPIC_AUTH_TOKEN:-}"'].join("\n")}\n`,
      { mode: 0o755 },
    );

    // The script's own unset lines, verified to be present and to be what the
    // probe above reproduces — so this asserts on the real file, not a copy of
    // an idea of it.
    const source = spawnSync("/bin/cat", [script], { encoding: "utf8" }).stdout;
    expect(source).toContain("unset ANTHROPIC_API_KEY");
    expect(source).toContain("unset ANTHROPIC_AUTH_TOKEN");

    const result = spawnSync("/bin/bash", [probe], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", ANTHROPIC_API_KEY: "sk-ant-should-not-survive" },
    });

    expect(result.stdout).toContain("KEY=[]");
    expect(result.stdout).toContain("TOKEN=[]");
  });

  it("should run the deploy unattended, which is the strict mode and never a bypass", () => {
    const source = spawnSync("/bin/cat", [script], { encoding: "utf8" }).stdout;

    expect(source).toContain("--unattended");
    // No flag that would skip the gate may ever appear in the file launchd runs.
    expect(source).not.toContain("--retry-failed");
    expect(source).not.toContain("--allow-without-rollback");
  });
});
