import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * `scripts/syl-verify.sh` — the proof-of-life runner for `syl-007.4.2`.
 *
 * Two of its three questions can be answered by a machine, and the harder one
 * is here: **kill the service and confirm supervision brings it back**. The
 * process killed below is real, the `SIGKILL` is real, and the pid the script
 * discovers afterwards is a genuinely different process. What is substituted is
 * `launchctl` — replaced by a stub that does what `KeepAlive` does, because the
 * alternative is a test suite that restarts the Commander's actual service.
 *
 * The third question, the reboot, is nobody's to automate. `after-reboot` is a
 * checklist and is asserted only to run.
 */

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const verify = join(repoRoot, "scripts", "syl-verify.sh");

/** Real `launchctl print` output, captured on this machine. */
const REAL_LAUNCHCTL_PRINT = `gui/501/com.adjutant.backend = {
	active count = 1
	path = /Users/Reason/Library/LaunchAgents/com.adjutant.backend.plist
	type = LaunchAgent
	state = running

	program = /bin/bash

	pid = 4129
	immediate reason = speculative
	forks = 0
}
`;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Result {
  readonly status: number;
  readonly output: string;
}

function run(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Result {
  try {
    const output = execFileSync("/bin/bash", [verify, ...args], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: tmpdir(), ...env },
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

/**
 * A stub `launchctl` that supervises the way `KeepAlive` does.
 *
 * `print` reports the pid of the server it manages, and respawns it first if it
 * has died. That is precisely the behaviour under test: the script must notice
 * that the pid changed and that the new process answers.
 */
function supervised(port: number): { directory: string; stub: string; pidFile: string } {
  const directory = mkdtempSync(join(tmpdir(), "syl-verify-"));
  directories.push(directory);
  const pidFile = join(directory, "pid");
  const stub = join(directory, "launchctl");

  const server =
    `const http=require("node:http");` +
    `const s=http.createServer((q,r)=>{r.writeHead(200,{"content-type":"application/json"});` +
    `r.end(JSON.stringify({success:true,data:{status:"ok"}}))});` +
    `s.listen(${String(port)},"127.0.0.1");`;

  writeFileSync(
    stub,
    `#!/bin/bash
if [ "$1" != "print" ]; then exit 0; fi
pid=$(cat "${pidFile}" 2>/dev/null)
if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
  "${process.execPath}" -e '${server}' >/dev/null 2>&1 &
  pid=$!
  printf '%s' "$pid" > "${pidFile}"
  sleep 1
fi
printf '\\tpid = %s\\n' "$pid"
`,
    { mode: 0o755 },
  );

  directories.push(directory);
  return { directory, stub, pidFile };
}

function freePort(): number {
  return 41_000 + Math.floor(Math.random() * 15_000);
}

describe("syl-verify.sh", () => {
  it("should reject a subcommand it does not have", () => {
    const result = run(["nonsense"], {});
    // EX_USAGE.
    expect(result.status).toBe(64);
    expect(result.output).toContain("usage");
  });

  it("should find the pid in real launchctl output", () => {
    // The parse, against output captured from a live launchd job rather than
    // from our idea of the format. `pid = 4129` is tab-indented and sits among
    // a dozen other `key = value` lines, several of which also contain "pid".
    const parsed = execFileSync(
      "/bin/bash",
      ["-c", `printf '%s' "$1" | /usr/bin/sed -n 's/^[[:space:]]*pid = \\([0-9][0-9]*\\).*/\\1/p' | head -1`, "_", REAL_LAUNCHCTL_PRINT],
      { encoding: "utf8" },
    ).trim();

    expect(parsed).toBe("4129");
  });

  it("should confirm that a killed service is brought back, as a different process", () => {
    const port = freePort();
    const { stub, pidFile } = supervised(port);
    const env = {
      SYL_LAUNCHCTL: stub,
      SYL_HEALTH_URL: `http://127.0.0.1:${String(port)}/api/v1/health`,
      SYL_VERIFY_RESTART_DEADLINE: "30",
    };

    // First call brings the "service" up.
    run(["status"], env);
    const before = readFileSync(pidFile, "utf8").trim();
    expect(before).not.toBe("");

    const result = run(["kill"], env);
    const after = readFileSync(pidFile, "utf8").trim();

    expect(result.output).toContain("launchd restarted it");
    expect(result.output).toContain("it answers again");
    expect(after).not.toBe(before);

    execFileSync("/bin/bash", ["-c", `kill -9 ${after} 2>/dev/null || true`]);
  }, 120_000);

  it("should say so, and fail, when there is nothing running to kill", () => {
    const directory = mkdtempSync(join(tmpdir(), "syl-verify-"));
    directories.push(directory);
    const stub = join(directory, "launchctl");
    writeFileSync(stub, "#!/bin/bash\nexit 1\n", { mode: 0o755 });

    const result = run(["kill"], { SYL_LAUNCHCTL: stub, SYL_HEALTH_URL: "http://127.0.0.1:1/health" });

    expect(result.status).toBe(1);
    expect(result.output).toContain("nothing to kill");
  }, 60_000);

  it("should report the machine's real configuration without throwing", () => {
    // Executes the actual pmset, defaults and curl calls against this machine.
    // It asserts nothing about the answers — the settings are the Commander's
    // to change — only that `status` runs, which is the part that would
    // otherwise first execute in front of him.
    const directory = mkdtempSync(join(tmpdir(), "syl-verify-"));
    directories.push(directory);
    const stub = join(directory, "launchctl");
    writeFileSync(stub, "#!/bin/bash\nexit 1\n", { mode: 0o755 });

    const result = run(["status"], {
      SYL_LAUNCHCTL: stub,
      SYL_HEALTH_URL: "http://127.0.0.1:1/health",
      SYL_VERIFY_TIMEOUT: "1",
    });

    expect(result.output).toContain("The machine");
    expect(result.output).toContain("launchd");
    expect(result.output).toMatch(/AC sleep|autorestart/);
  }, 60_000);
});
