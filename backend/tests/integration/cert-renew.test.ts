import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { queryLog } from "../../src/ops/log-query.js";
import { judgeCertStatus, readCertStatus } from "../../src/ops/tailnet-cert.js";

/**
 * The renewal job, run as the real script.
 *
 * `tailscale` is stubbed and nothing else is: the openssl calls, the date
 * arithmetic, the status file, the exit codes and the log records are all the
 * production article. That matters more here than almost anywhere, because this
 * script will run **eighty-nine times doing nothing** and then once for real,
 * months from now, unattended — and the only evidence anybody will have that it
 * worked is the file it wrote.
 *
 * The stub issues genuine self-signed certificates with `openssl`, so "does the
 * script correctly conclude this certificate has 5 days left" is answered by
 * the same tool that will answer it in production.
 */

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const script = join(repoRoot, "scripts", "syl-cert-renew.sh");
const HOSTNAME = "syl.tail1234.ts.net";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Run {
  readonly status: number;
  readonly output: string;
}

interface Harness {
  readonly home: string;
  readonly certDir: string;
  readonly certFile: string;
  readonly statusFile: string;
  readonly logDirectory: string;
  /** Install a stub `tailscale` that issues a certificate valid for `days`. */
  stubIssuing(days: number): void;
  /** Install a stub `tailscale` that fails. */
  stubFailing(): void;
  /** Put a certificate of `days` validity on disk without involving the stub. */
  seedCert(days: number): void;
  /** How many times the stub was invoked. */
  invocations(): number;
  run(overrides?: Readonly<Record<string, string>>): Run;
}

function harness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "syl-cert-"));
  directories.push(home);
  const certDir = join(home, "certs");
  const logDirectory = join(home, "logs");
  const statusFile = join(home, "cert-status.json");
  const stub = join(home, "tailscale");
  const calls = join(home, "tailscale.calls");
  mkdirSync(certDir, { recursive: true });

  const issue = (target: string, key: string, days: number): void => {
    execFileSync(
      "/usr/bin/openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-days", String(days),
        "-subj", `/CN=${HOSTNAME}`,
        "-keyout", key,
        "-out", target,
      ],
      { stdio: "ignore" },
    );
  };

  const certFile = join(certDir, `${HOSTNAME}.crt`);
  const keyFile = join(certDir, `${HOSTNAME}.key`);

  return {
    home,
    certDir,
    certFile,
    statusFile,
    logDirectory,
    stubIssuing: (days) => {
      // A stub that issues a real certificate, so everything downstream of it —
      // the openssl checks, the day count, the alarm threshold — is exercised
      // against a genuine X.509 file rather than a fixture.
      writeFileSync(
        stub,
        `#!/bin/bash\n` +
          `printf '%s\\n' "$*" >> "${calls}"\n` +
          `/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days ${String(days)} ` +
          `-subj "/CN=${HOSTNAME}" -keyout "${keyFile}" -out "${certFile}" >/dev/null 2>&1\n`,
        { mode: 0o755 },
      );
    },
    stubFailing: () => {
      writeFileSync(
        stub,
        `#!/bin/bash\nprintf '%s\\n' "$*" >> "${calls}"\n` +
          `echo "no such host: ${HOSTNAME}" >&2\nexit 1\n`,
        { mode: 0o755 },
      );
    },
    seedCert: (days) => issue(certFile, keyFile, days),
    invocations: () =>
      existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((line) => line !== "").length : 0,
    run: (overrides = {}) => {
      try {
        const output = execFileSync("/bin/bash", [script], {
          encoding: "utf8",
          env: {
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            HOME: home,
            SYL_TAILSCALE_BIN: stub,
            SYL_TAILNET_HOSTNAME: HOSTNAME,
            SYL_CERT_DIR: certDir,
            SYL_CERT_STATUS: statusFile,
            SYL_LOG_DIR: logDirectory,
            // No desktop notification from a test suite.
            SYL_CERT_NOTIFY: "/nonexistent",
            ...overrides,
          },
        });
        return { status: 0, output };
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
      }
    },
  };
}

describe("the tailnet certificate renewal", () => {
  it("should issue one when there is none", () => {
    const harnessed = harness();
    harnessed.stubIssuing(90);

    expect(harnessed.run().status).toBe(0);

    expect(existsSync(harnessed.certFile)).toBe(true);
    expect(harnessed.invocations()).toBe(1);
    const status = readCertStatus(harnessed.statusFile);
    expect(status?.ok).toBe(true);
    expect(status?.renewed).toBe(true);
    expect(status?.daysRemaining).toBeGreaterThan(80);
  }, 60_000);

  it("should do nothing when the certificate has plenty of time left", () => {
    // Ninety of the ninety runs between renewals land here. Calling
    // `tailscale cert` every night when there is nothing to do is how a job
    // gets rate-limited into failing on the one night it matters.
    const harnessed = harness();
    harnessed.seedCert(80);
    harnessed.stubIssuing(90);

    expect(harnessed.run().status).toBe(0);

    expect(harnessed.invocations()).toBe(0);
    const status = readCertStatus(harnessed.statusFile);
    expect(status?.ok).toBe(true);
    expect(status?.renewed).toBe(false);
  }, 60_000);

  it("should renew once the certificate is inside the window", () => {
    const harnessed = harness();
    harnessed.seedCert(5);
    harnessed.stubIssuing(90);

    expect(harnessed.run().status).toBe(0);

    expect(harnessed.invocations()).toBe(1);
    const status = readCertStatus(harnessed.statusFile);
    expect(status?.renewed).toBe(true);
    expect(status?.daysRemaining).toBeGreaterThan(80);
  }, 60_000);

  it("should respect a different threshold", () => {
    const harnessed = harness();
    harnessed.seedCert(40);
    harnessed.stubIssuing(90);

    harnessed.run({ SYL_CERT_MIN_DAYS: "60" });

    expect(harnessed.invocations()).toBe(1);
  }, 60_000);

  it("should fail loudly and non-zero when tailscale refuses", () => {
    // The failure that matters. A renewal job that fails quietly converts a
    // known 90-day deadline into a surprise outage.
    const harnessed = harness();
    harnessed.seedCert(5);
    harnessed.stubFailing();

    const run = harnessed.run();

    expect(run.status).toBe(1);
    const status = readCertStatus(harnessed.statusFile);
    expect(status?.ok).toBe(false);
    expect(status?.error).toContain("tailscale cert exited 1");
    expect(queryLog(harnessed.logDirectory, { filename: "cert-renew.log", minLevel: "error" })).not.toEqual(
      [],
    );
  }, 60_000);

  it("should treat a renewal that did not extend anything as a failure", () => {
    // The dangerous case: exit code zero, everything looks fine, and the outage
    // is still scheduled. Checking the exit code alone would miss it.
    const harnessed = harness();
    harnessed.seedCert(5);
    harnessed.stubIssuing(3);

    const run = harnessed.run();

    expect(run.status).toBe(1);
    const status = readCertStatus(harnessed.statusFile);
    expect(status?.ok).toBe(false);
    expect(status?.error).toContain("did not extend");
  }, 60_000);

  it("should refuse, rather than guess, when there is no tailscale", () => {
    const harnessed = harness();

    const run = harnessed.run({ SYL_TAILSCALE_BIN: "/nonexistent/tailscale" });

    // EX_CONFIG. And the message names the standalone client, because the App
    // Store build cannot run as a boot daemon at all.
    expect(run.status).toBe(78);
    expect(run.output).toContain("STANDALONE");
  }, 60_000);

  it("should refuse when the hostname is unknown", () => {
    const harnessed = harness();
    harnessed.stubIssuing(90);

    const run = harnessed.run({ SYL_TAILNET_HOSTNAME: "" });

    expect(run.status).toBe(78);
    expect(readCertStatus(harnessed.statusFile)?.ok).toBe(false);
  }, 60_000);

  it("should write a status the health probe understands", () => {
    // The two halves of this bead meet here: the script writes, the service
    // reads, and neither has ever been run against the other before.
    const harnessed = harness();
    harnessed.stubIssuing(90);
    harnessed.run();

    const judged = judgeCertStatus(readCertStatus(harnessed.statusFile), Date.now());
    expect(judged.status).toBe("ok");
    expect(judged.detail).toContain(HOSTNAME);
  }, 60_000);

  it("should produce a status the health probe calls degraded when renewal failed", () => {
    const harnessed = harness();
    harnessed.seedCert(5);
    harnessed.stubFailing();
    harnessed.run();

    const judged = judgeCertStatus(readCertStatus(harnessed.statusFile), Date.now());
    expect(judged.status).toBe("degraded");
  }, 60_000);
});
