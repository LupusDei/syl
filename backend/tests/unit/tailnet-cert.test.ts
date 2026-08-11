import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CERT_STALE_MS,
  CERT_WARN_DAYS,
  defaultCertStatusPath,
  judgeCertStatus,
  readCertStatus,
  tailnetCertProbe,
  type CertStatus,
} from "../../src/ops/tailnet-cert.js";

/**
 * The certificate health check.
 *
 * The failure being guarded against is not the certificate expiring — that is
 * ninety days away and the renewal job handles it. It is the renewal job
 * quietly stopping, which from the outside looks exactly like everything being
 * fine, right up until the morning the phone cannot complete a TLS handshake.
 * So staleness is a fault in its own right, and it is the check most likely to
 * earn its keep.
 */

const NOW = Date.parse("2026-08-09T12:00:00.000Z");

let directory: string | null = null;

afterEach(() => {
  if (directory !== null) rmSync(directory, { recursive: true, force: true });
  directory = null;
});

function statusFile(contents: string): string {
  directory ??= mkdtempSync(join(tmpdir(), "syl-cert-status-"));
  const path = join(directory, "cert-status.json");
  writeFileSync(path, contents);
  return path;
}

function status(overrides: Partial<CertStatus> = {}): CertStatus {
  return {
    checkedAt: new Date(NOW - 60_000).toISOString(),
    hostname: "syl.tail1234.ts.net",
    certPath: "/Users/c/.syl/certs/syl.tail1234.ts.net.crt",
    ok: true,
    renewed: false,
    daysRemaining: 85,
    error: null,
    ...overrides,
  };
}

describe("readCertStatus", () => {
  it("should read what the renewal script writes", () => {
    const path = statusFile(
      JSON.stringify({
        checkedAt: "2026-08-09T03:40:00.000Z",
        hostname: "syl.tail1234.ts.net",
        certPath: "/tmp/x.crt",
        ok: true,
        renewed: true,
        daysRemaining: 89,
        error: null,
      }),
    );

    expect(readCertStatus(path)).toMatchObject({ ok: true, renewed: true, daysRemaining: 89 });
  });

  it("should return null when the file is not there", () => {
    expect(readCertStatus(join(tmpdir(), "syl-no-such-status.json"))).toBeNull();
  });

  it("should return null rather than throw on a half-written file", () => {
    // The script writes this with a heredoc; a power cut mid-write is exactly
    // the situation in which somebody is reading it.
    expect(readCertStatus(statusFile('{"checkedAt": "2026-'))).toBeNull();
  });

  it("should reject a document that is not an object", () => {
    expect(readCertStatus(statusFile("[1,2,3]"))).toBeNull();
  });

  it("should treat a null daysRemaining as unknown rather than zero", () => {
    // The difference between "we could not read the certificate" and "it
    // expires today" is the difference between degraded and down.
    const path = statusFile(JSON.stringify({ checkedAt: "2026-08-09T00:00:00Z", daysRemaining: null }));
    expect(readCertStatus(path)?.daysRemaining).toBeNull();
  });
});

describe("judgeCertStatus", () => {
  it("should be satisfied by a fresh, comfortable certificate", () => {
    const judged = judgeCertStatus(status(), NOW);
    expect(judged.status).toBe("ok");
    expect(judged.detail).toContain("syl.tail1234.ts.net");
  });

  it("should say so when renewal has never reported at all", () => {
    const judged = judgeCertStatus(null, NOW);
    expect(judged.status).toBe("degraded");
    expect(judged.detail).toContain("com.jmm.syl.cert");
  });

  it("should treat a stale report as a stopped job", () => {
    // The check that matters most. A daily job that has not run in three days
    // has stopped, and a stopped renewal is how a known deadline becomes a
    // surprise.
    const judged = judgeCertStatus(
      status({ checkedAt: new Date(NOW - CERT_STALE_MS - 60_000).toISOString() }),
      NOW,
    );

    expect(judged.status).toBe("degraded");
    expect(judged.detail).toContain("stopped running");
  });

  it("should accept a report from within the staleness window", () => {
    const judged = judgeCertStatus(
      status({ checkedAt: new Date(NOW - CERT_STALE_MS + 60_000).toISOString() }),
      NOW,
    );
    expect(judged.status).toBe("ok");
  });

  it("should report the last failure's reason", () => {
    const judged = judgeCertStatus(status({ ok: false, error: "no such host" }), NOW);
    expect(judged.status).toBe("degraded");
    expect(judged.detail).toContain("no such host");
  });

  it("should warn while there is still time to fix it", () => {
    const judged = judgeCertStatus(status({ daysRemaining: CERT_WARN_DAYS - 1 }), NOW);
    expect(judged.status).toBe("degraded");
    expect(judged.detail).toContain("expires in");
  });

  it("should call an expired certificate down, not degraded", () => {
    // Degraded means "still worth talking to". An expired certificate means the
    // phone cannot connect at all, which is the definition of down.
    const judged = judgeCertStatus(status({ daysRemaining: 0 }), NOW);
    expect(judged.status).toBe("down");
    expect(judged.detail).toContain("EXPIRED");
  });

  it("should treat an unreadable expiry as degraded", () => {
    expect(judgeCertStatus(status({ daysRemaining: null }), NOW).status).toBe("degraded");
  });

  it("should treat an unparseable timestamp as degraded", () => {
    expect(judgeCertStatus(status({ checkedAt: "whenever" }), NOW).status).toBe("degraded");
  });
});

describe("tailnetCertProbe", () => {
  it("should re-read the status file on every request", () => {
    // Another process renews the certificate while this one runs. A value
    // captured at boot would be wrong for the whole life of a service that
    // never restarts.
    const path = statusFile(JSON.stringify(status({ ok: false, error: "first" })));
    const probe = tailnetCertProbe({ path, now: () => NOW });

    expect(probe.run().status).toBe("degraded");
    writeFileSync(path, JSON.stringify(status()));
    expect(probe.run().status).toBe("ok");
  });

  it("should be named so a health response can be read at a glance", () => {
    expect(tailnetCertProbe({ path: "/nonexistent" }).name).toBe("tailnet-cert");
  });

  it("should never throw, whatever is on disk", () => {
    const probe = tailnetCertProbe({ path: statusFile("not json at all") });
    expect(() => probe.run()).not.toThrow();
  });
});

describe("defaultCertStatusPath", () => {
  it("should prefer SYL_CERT_STATUS", () => {
    expect(defaultCertStatusPath({ SYL_CERT_STATUS: "/var/syl/cert.json" })).toBe("/var/syl/cert.json");
  });

  it("should fall back to the home dot-directory", () => {
    expect(defaultCertStatusPath({ HOME: "/Users/c" })).toBe("/Users/c/.syl/cert-status.json");
  });
});
