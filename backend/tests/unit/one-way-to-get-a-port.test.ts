import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { freeLoopbackPort } from "../helpers/http.js";

const testsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * ONE WAY TO GET A PORT, AND IT IS NOT GUESSING — `syl-zui3`.
 *
 * Three files each grew a function called `freePort`, and no two agreed:
 *
 *     service-lifecycle.test.ts   39_000 + random(10_000)   a guess
 *     verify-script.test.ts       41_000 + random(15_000)   a guess
 *     compact-cli.test.ts         bind :0, else a guess     nearly right
 *
 * **The name is the defect.** `freePort()` asserts precisely the property it
 * does not provide, so five call sites used it without a second thought and it
 * survived review three times.
 *
 * Both guesses draw from inside the kernel's own ephemeral range — 32768-60999
 * on Linux — so they are not sampling unused ports, they are sampling the pool
 * every outbound socket in the suite is already drawing from.
 *
 * It has now failed CI twice, and the two failures look nothing alike:
 *
 * - `service-lifecycle`, 2026-08-23 15:00 — a loud `EADDRINUSE 127.0.0.1:39868`.
 * - `verify-script`, 2026-08-23 17:54 — `nothing bound 127.0.0.1:53040 within
 *   40000ms`, because that stub is spawned with `stdio: "ignore"` and the bind
 *   error went nowhere. Forty seconds of silence describing a symptom and
 *   naming none of the cause.
 *
 * Same bug, opposite symptoms, and the second cost an evening. So: one helper,
 * beside `startTestApp`, which has been doing it correctly all along — and a
 * scan, because the durable half of this fix is that a fourth one cannot
 * appear.
 */
describe("one way to get a port", () => {
  it("should hand back a port that is genuinely bindable", async () => {
    const port = await freeLoopbackPort();

    await expect(
      new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.close(() => resolve(port));
        });
      }),
    ).resolves.toBe(port);
  });

  it("should not hand the same port to two callers at once", async () => {
    // Held open, so the second call cannot be given it. A guess has no way to
    // know and this is the whole difference.
    const first = await freeLoopbackPort();
    const held = createServer();
    await new Promise<void>((resolve) => held.listen(first, "127.0.0.1", resolve));
    try {
      const second = await freeLoopbackPort();
      expect(second).not.toBe(first);
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()));
    }
  });

  /** Every `*.test.ts` and helper under `backend/tests`. */
  function testSources(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
    };
    walk(testsRoot);
    return out;
  }

  it("should be the ONLY way — no file may grow its own port guess", () => {
    // The scan is the durable half. A comment saying "use the helper" is what
    // the last three authors did not read; this is red the moment a fourth
    // appears, and it names the file.
    const guessing: string[] = [];
    for (const file of testSources()) {
      if (file === fileURLToPath(import.meta.url)) continue;
      const source = readFileSync(file, "utf8");
      // A port number arrived at by arithmetic on Math.random(). The shape of
      // all three, whatever the constants.
      if (/\d[\d_]{3,}\s*\+\s*Math\.floor\(Math\.random\(\)/.test(source)) {
        guessing.push(relative(testsRoot, file).split(sep).join("/"));
      }
    }

    expect(guessing).toEqual([]);
  });

  it("should be the only DEFINITION too, so three helpers cannot drift again", () => {
    const defining: string[] = [];
    for (const file of testSources()) {
      if (file.endsWith(join("helpers", "http.ts"))) continue;
      if (file === fileURLToPath(import.meta.url)) continue;
      if (/function\s+freePort\b/.test(readFileSync(file, "utf8"))) {
        defining.push(relative(testsRoot, file).split(sep).join("/"));
      }
    }

    expect(defining).toEqual([]);
  });
});
