import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CERT_LABEL,
  CORE_LABEL,
  coreJob,
  certJob,
  installCommands,
  launchdPath,
  sylLaunchdJobs,
  toPlistXml,
  WATCHDOG_LABEL,
  watchdogJob,
  type LaunchdPaths,
  type PlistValue,
} from "../../src/ops/launchd.js";

/**
 * The plists, checked by the tool that will actually have to read them.
 *
 * Asserting on the generated XML with a regular expression would prove that our
 * renderer agrees with our test and nothing else. `plutil` is what launchd uses
 * to parse these, so every case here writes a real file and asks `plutil` to
 * lint and then to re-read it — which is the only way to find out that, for
 * example, a `<true/>` written as `<true></true>` or an unescaped `&` in a path
 * makes the whole job silently unloadable.
 */

const paths: LaunchdPaths = {
  repoRoot: "/Users/commander/code/syl",
  home: "/Users/commander",
  logDirectory: "/Users/commander/Library/Logs/Syl",
  nodeBin: "/opt/homebrew/bin/node",
  databasePath: "/Users/commander/.syl/syl.db",
  port: 4201,
  tailnetHostname: "syl.tail1234.ts.net",
  environment: { SYL_APNS_BUNDLE_ID: "com.jmm.syl", SYL_TZ: "America/Chicago" },
};

let directory: string | null = null;

afterEach(() => {
  if (directory !== null) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

/** Write a plist and read it back through `plutil`, as launchd would. */
function roundTrip(value: PlistValue): Record<string, unknown> {
  directory ??= mkdtempSync(join(tmpdir(), "syl-plist-"));
  const path = join(directory, `${String(Math.random()).slice(2)}.plist`);
  writeFileSync(path, toPlistXml(value));

  // Lints as a property list at all. A malformed one fails here with a line
  // number, which is exactly the feedback a hand-written plist never gives.
  execFileSync("/usr/bin/plutil", ["-lint", path], { encoding: "utf8" });

  const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
    encoding: "utf8",
  });
  return JSON.parse(json) as Record<string, unknown>;
}

describe("toPlistXml", () => {
  it("should produce something plutil accepts", () => {
    expect(roundTrip({ Label: "x" })).toEqual({ Label: "x" });
  });

  it("should round-trip every type a launchd job uses", () => {
    const value = {
      Label: "com.example",
      ProgramArguments: ["/bin/bash", "/tmp/run.sh"],
      RunAtLoad: true,
      KeepAlive: false,
      ThrottleInterval: 10,
      StartCalendarInterval: { Hour: 3, Minute: 40 },
      EnvironmentVariables: { PATH: "/usr/bin:/bin" },
    } as const;

    expect(roundTrip(value)).toEqual(value);
  });

  it("should escape a path that would otherwise break the XML", () => {
    // A repository under `~/code/a & b` is not a hypothetical; an unescaped
    // ampersand makes the entire job unloadable with no message anywhere.
    const parsed = roundTrip({ WorkingDirectory: "/Users/c/code/a & b/<syl>" });
    expect(parsed["WorkingDirectory"]).toBe("/Users/c/code/a & b/<syl>");
  });

  it("should render an empty array and an empty dictionary", () => {
    expect(roundTrip({ a: [], b: {} })).toEqual({ a: [], b: {} });
  });

  it("should render a non-integer as a real", () => {
    expect(roundTrip({ n: 1.5 })).toEqual({ n: 1.5 });
  });
});

describe("the core job", () => {
  it("should be a plist plutil accepts", () => {
    expect(() => roundTrip(coreJob(paths).plist)).not.toThrow();
  });

  it("should restart a dead process and back off when it dies repeatedly", () => {
    const plist = roundTrip(coreJob(paths).plist);
    expect(plist["RunAtLoad"]).toBe(true);
    expect(plist["KeepAlive"]).toBe(true);
    expect(plist["ThrottleInterval"]).toBe(10);
  });

  it("should give the service longer to stop than its own shutdown deadline", () => {
    // The service exits itself at 15 seconds. launchd's grace must be longer,
    // or the SIGKILL arrives first and the line saying why is never written.
    expect(roundTrip(coreJob(paths).plist)["ExitTimeOut"]).toBe(20);
  });

  it("should not be Background, which throttles I/O", () => {
    // Adjutant's plist uses Background. Right for an indexer, wrong for
    // something a phone is waiting on over a tunnel.
    expect(roundTrip(coreJob(paths).plist)["ProcessType"]).toBe("Adaptive");
  });

  it("should carry a PATH that does not depend on a shell profile", () => {
    // launchd hands a job /usr/bin:/bin:/usr/sbin:/sbin and nothing else. The
    // same lesson claude-bin.ts already learned: resolves under zsh, ENOENT
    // under launchd.
    const environment = roundTrip(coreJob(paths).plist)["EnvironmentVariables"] as Record<string, string>;
    expect(environment["PATH"]).toContain("/opt/homebrew/bin");
    expect(environment["PATH"]).toContain("/Users/commander/.local/bin");
  });

  it("should set HOME, which launchd does not", () => {
    const environment = roundTrip(coreJob(paths).plist)["EnvironmentVariables"] as Record<string, string>;
    expect(environment["HOME"]).toBe("/Users/commander");
  });

  it("should run in production with an absolute store and log directory", () => {
    const environment = roundTrip(coreJob(paths).plist)["EnvironmentVariables"] as Record<string, string>;
    expect(environment["NODE_ENV"]).toBe("production");
    expect(environment["SYL_DB_PATH"]).toBe("/Users/commander/.syl/syl.db");
    expect(environment["SYL_LOG_DIR"]).toBe("/Users/commander/Library/Logs/Syl");
    expect(environment["PORT"]).toBe("4201");
  });

  it("should forward the extra environment it was given", () => {
    const environment = roundTrip(coreJob(paths).plist)["EnvironmentVariables"] as Record<string, string>;
    expect(environment["SYL_APNS_BUNDLE_ID"]).toBe("com.jmm.syl");
    expect(environment["SYL_TZ"]).toBe("America/Chicago");
  });

  it("should launch the wrapper script, which is what execs node", () => {
    const args = roundTrip(coreJob(paths).plist)["ProgramArguments"] as string[];
    expect(args).toEqual(["/bin/bash", "/Users/commander/code/syl/scripts/syl-service.sh"]);
  });
});

describe("the watchdog job", () => {
  it("should be a plist plutil accepts", () => {
    expect(() => roundTrip(watchdogJob(paths).plist)).not.toThrow();
  });

  it("should run on an interval rather than once", () => {
    const plist = roundTrip(watchdogJob(paths).plist);
    expect(plist["StartInterval"]).toBe(60);
    expect(plist["KeepAlive"]).toBeUndefined();
  });

  it("should not run at load, when the core job is still binding its port", () => {
    // A watchdog that probes at load counts a failure against the service on
    // every single boot.
    expect(roundTrip(watchdogJob(paths).plist)["RunAtLoad"]).toBe(false);
  });

  it("should know which label to restart and which port to probe", () => {
    const environment = roundTrip(watchdogJob(paths).plist)["EnvironmentVariables"] as Record<
      string,
      string
    >;
    expect(environment["SYL_CORE_LABEL"]).toBe(CORE_LABEL);
    expect(environment["SYL_PORT"]).toBe("4201");
  });
});

describe("the certificate job", () => {
  it("should be a plist plutil accepts", () => {
    expect(() => roundTrip(certJob(paths).plist)).not.toThrow();
  });

  it("should run daily inside quiet hours, and also at load", () => {
    // At load as well, because after a power cut the machine was off at 03:40
    // and waiting until tomorrow is a day of an expiring certificate spent
    // doing nothing.
    const plist = roundTrip(certJob(paths).plist);
    expect(plist["StartCalendarInterval"]).toEqual({ Hour: 3, Minute: 40 });
    expect(plist["RunAtLoad"]).toBe(true);
  });

  it("should pass the tailnet hostname through when it is known", () => {
    const environment = roundTrip(certJob(paths).plist)["EnvironmentVariables"] as Record<string, string>;
    expect(environment["SYL_TAILNET_HOSTNAME"]).toBe("syl.tail1234.ts.net");
  });

  it("should omit the hostname rather than write an empty one", () => {
    // An empty SYL_TAILNET_HOSTNAME would defeat the script's own fallback,
    // which asks tailscale what this node is called.
    const { tailnetHostname, ...withoutHost } = paths;
    void tailnetHostname;
    const environment = roundTrip(certJob(withoutHost).plist)["EnvironmentVariables"] as Record<
      string,
      string
    >;
    expect(environment["SYL_TAILNET_HOSTNAME"]).toBeUndefined();
  });
});

describe("sylLaunchdJobs", () => {
  it("should produce all three, each named after its label", () => {
    const jobs = sylLaunchdJobs(paths);
    expect(jobs.map((job) => job.label)).toEqual([CORE_LABEL, WATCHDOG_LABEL, CERT_LABEL]);
    for (const job of jobs) expect(job.filename).toBe(`${job.label}.plist`);
  });

  it("should agree with the Label inside each plist", () => {
    // A filename that disagrees with the Label loads under the label and is
    // then unfindable by the filename anybody looks for.
    for (const job of sylLaunchdJobs(paths)) {
      expect(job.plist["Label"]).toBe(job.label);
    }
  });
});

describe("launchdPath", () => {
  it("should include the places a Mac actually installs binaries", () => {
    const path = launchdPath("/Users/c").split(":");
    expect(path).toContain("/Users/c/.local/bin");
    expect(path).toContain("/opt/homebrew/bin");
    expect(path).toContain("/usr/bin");
  });
});

describe("installCommands", () => {
  it("should bootout before bootstrap, tolerating a label that is not loaded", () => {
    // `bootstrap` on an already-loaded label fails with "Input/output error",
    // which says nothing about the cause; `bootout` on an unloaded one fails
    // the same unhelpful way, which is the first-install case.
    const commands = installCommands(coreJob(paths), { uid: 501 });
    expect(commands[0]).toContain("bootout gui/501/com.jmm.syl.core");
    expect(commands[0]).toContain("|| true");
    expect(commands[1]).toContain("bootstrap gui/501");
  });
});
