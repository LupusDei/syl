import type { ApiError } from "@syl/shared";
import { afterEach, describe, expect, it } from "vitest";

import { API_BASE_PATH, createApp } from "../../src/index.js";
import {
  FACE_PAGE_API_BASE,
  FACE_PAGE_HTML,
  FACE_PAGE_PATH,
} from "../../src/routes/face-page.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * The page her face is drawn on — `syl-chzl.7.5`.
 *
 * The phone opens a full-screen `WKWebView` over this document and the document
 * does the WebRTC, which is the whole reason no LiveKit SDK is compiled into the
 * app. So the tests here are about the two things that can go wrong with a
 * static surface that stands in front of a paid stream:
 *
 * 1. **It carries nothing secret.** Not the org secret, not a session key, and
 *    not anything a caller put in the URL — a page that reflects its query
 *    string is a page that will one day reflect a credential into a proxy log.
 * 2. **It is scoped.** It is served from its own prefix, mounted after the
 *    contract, and `/api/v1/<unknown>` still answers with Syl's JSON envelope.
 *    That is the same regression `admin.test.ts` pins, for the same reason.
 */

/** Either envelope, as a test reads it. */
interface Envelope<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

let running: RunningApp | undefined;
let db: SylDatabase | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  db?.close();
  db = undefined;
});

async function serve(): Promise<RunningApp> {
  db = testDatabase();
  running = await startTestApp(createApp(testConfig(), testDeps(db)));
  return running;
}

describe("the live face page", () => {
  it("should serve a document at its own path", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${FACE_PAGE_PATH}/live`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    // The mount point the phone is pointed at, and the SDK the page draws with.
    expect(body).toContain("avatars-react");
  });

  it("should never be cached", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${FACE_PAGE_PATH}/live`);

    // A page that stands in front of a session-scoped credential must not be
    // held by an intermediary. It is one document and it costs nothing to fetch.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("should carry no credential of any kind in its source", () => {
    // The org secret's own env name, and the shape of every credential in this
    // subsystem. Asserted against the SOURCE rather than a response, so a page
    // that gains a baked-in key is red at the module rather than at one route.
    expect(FACE_PAGE_HTML).not.toContain("RUNWAYML_API_SECRET");
    expect(FACE_PAGE_HTML).not.toContain("stk_");
    expect(FACE_PAGE_HTML).not.toMatch(/Bearer\s+\S/);
  });

  it("should not reflect anything a caller puts in the URL", async () => {
    const app = await serve();

    const smuggled = "stk_thiscamefromthequerystring";
    const response = await fetch(
      `${app.baseUrl}${FACE_PAGE_PATH}/live?sessionKey=${smuggled}&x=%3Cscript%3E`,
    );

    const body = await response.text();
    // **The reason the credential travels in the fragment, not the query.** A
    // static page cannot leak what it never reads, and a fragment is never sent
    // to the server at all — so there is no access log, no proxy log and no
    // referrer header anywhere on the path that has seen a session key.
    expect(body).not.toContain(smuggled);
    expect(body).not.toContain("<script>");
    expect(body).toBe(FACE_PAGE_HTML);
  });

  it("should refuse a method that is not a page request", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${FACE_PAGE_PATH}/live`, { method: "POST" });

    // Falls through to the service's own terminal 404 rather than answering a
    // POST with a document.
    expect(response.status).toBe(404);
    const body = (await response.json()) as Envelope;
    expect(body.success).toBe(false);
  });

  it("should leave the contract's 404 alone", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${API_BASE_PATH}/no-such-route`);

    // The page router is mounted at the root, so this is the ordering check:
    // an HTML page here would tell every client that Syl is not Syl.
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Envelope;
    expect(body.success).toBe(false);
  });

  describe("saying what became of it", () => {
    /**
     * The page's half of `0037`.
     *
     * On 2026-08-23 two face sessions billed ninety cents and produced no
     * server-side evidence of any kind, because everything that went wrong
     * went wrong inside a `WKWebView`. These assert the page can now say so —
     * against the SOURCE, so a page that loses its voice is red at the module
     * rather than on a device nobody can reproduce.
     */
    it("should know where to send a report", () => {
      // A duplicated constant with a test between the copies is a
      // correspondence check; with a comment it is how they drift. The page
      // cannot import `API_BASE_PATH` — `index.ts` imports this module.
      expect(FACE_PAGE_API_BASE).toBe(API_BASE_PATH);
      expect(FACE_PAGE_HTML).toContain("/report");
    });

    it("should prove it ran before it does anything that can kill it", () => {
      // `booting` is reported before any import, and `mic_requested` before the
      // call that terminated the app: iOS does not refuse an undeclared capture,
      // it kills the process, so a state reported afterwards can never describe
      // the failure. The last word on the row is where it died.
      const booting = FACE_PAGE_HTML.indexOf("'booting'");
      const requested = FACE_PAGE_HTML.indexOf("'mic_requested'");
      const firstImport = FACE_PAGE_HTML.indexOf("await import(");
      const getUserMedia = FACE_PAGE_HTML.indexOf("getUserMedia({ audio: true");

      expect(booting).toBeGreaterThan(-1);
      expect(booting).toBeLessThan(firstImport);
      expect(requested).toBeGreaterThan(-1);
      expect(requested).toBeLessThan(getUserMedia);
    });

    it("should fence the camera before it loads anything that could ask for one", () => {
      // The 2026-08-23 crash. `AvatarCall` is passed `video: false` and it
      // makes no difference, because it is livekit-client's device manager
      // asking — it unlocks device LABELS with `getUserMedia({video: true, …})`.
      // No prop reaches that, so the fence is at the chokepoint instead, and it
      // has to be installed before the SDK is imported to sit innermost.
      const fence = FACE_PAGE_HTML.indexOf("fenceTheCamera");
      const firstImport = FACE_PAGE_HTML.indexOf("await import(");

      expect(fence).toBeGreaterThan(-1);
      expect(fence).toBeLessThan(firstImport);
      expect(FACE_PAGE_HTML).toContain("'camera_blocked'");
    });
  });

  /**
   * How much of her is on screen — the 2026-08-23 over-crop.
   *
   * He saw his own phone filled brow to chin: no head, no hair, no shoulders,
   * a face pressed against glass. Runway streams 16:9 landscape and the page
   * was `object-fit: cover`-ing it into a ~9:19.5 portrait viewport, which
   * keeps the full height and throws away about three quarters of the width.
   *
   * These assert against the SOURCE because there is no viewport in a unit
   * test, and the property that matters is a property of the rule rather than
   * of one render: nothing on this page may crop her vertically.
   */
  describe("her framing", () => {
    it("should fit her to the width and never cover the viewport with her", () => {
      // `cover` in a portrait viewport IS the bug: it matches the height and
      // spends the width. Its absence is the assertion, not `contain`'s
      // presence — a rule that adds contain and leaves cover later in the
      // cascade is the same defect with more CSS.
      expect(FACE_PAGE_HTML).not.toContain("object-fit: cover");
      expect(FACE_PAGE_HTML).toContain("object-fit: contain");
    });

    it("should cap her box at the screen, so no zoom can take the top of her head", () => {
      // The whole safety argument for `--face-zoom`. The box is sized from the
      // viewport WIDTH, so zoom only ever spends width; `max-height: 100dvh`
      // is what stops a large one from spending height as well.
      expect(FACE_PAGE_HTML).toContain("--face-zoom");
      expect(FACE_PAGE_HTML).toMatch(/max-height:\s*100dvh/);
      expect(FACE_PAGE_HTML).toMatch(/width:\s*calc\(100vw \* var\(--face-zoom\)\)/);
    });

    it("should leave the veil to fill above and below her, not the widget's own backdrop", () => {
      // "Do not invent a new background; use the veil that is there." The SDK's
      // blurred backdrop was invisible under a full-bleed video and would be
      // the only thing in the letterbox bands now that there are bands.
      expect(FACE_PAGE_HTML).toContain('<div class="veil">');
      expect(FACE_PAGE_HTML).toMatch(/\[data-avatar-call\]::before[^{]*\{[^}]*display:\s*none/);
    });
  });

  /**
   * The status sentence sat at `bottom: 0` on top of the SDK's mic, camera and
   * hang-up buttons: "Waking her." drawn across the only controls the surface
   * has, and eating the taps meant for them.
   */
  describe("the status sentence and the controls", () => {
    it("should not be pinned to the bottom of the screen, where the controls live", () => {
      const status = FACE_PAGE_HTML.slice(
        FACE_PAGE_HTML.indexOf("#status {"),
        FACE_PAGE_HTML.indexOf("#status.err"),
      );

      expect(status).not.toMatch(/bottom:\s*0/);
    });

    it("should never be able to swallow a press meant for a control", () => {
      // The belt, and it is the half that survives the SDK moving its own
      // furniture: wherever the buttons end up, a label is not a target.
      const status = FACE_PAGE_HTML.slice(
        FACE_PAGE_HTML.indexOf("#status {"),
        FACE_PAGE_HTML.indexOf("#status.err"),
      );

      expect(status).toMatch(/pointer-events:\s*none/);
    });
  });

  /**
   * Thirty-five seconds of "Waking her." at about twenty cents a minute.
   *
   * The page's share of that is its own: a render-blocking stylesheet in front
   * of its first line, and three module downloads run end to end.
   */
  describe("how long she takes to appear", () => {
    it("should not let a CDN stylesheet block its own first line", () => {
      // A parser-inserted script waits for every stylesheet declared before it,
      // so this round trip ran BEFORE `tell('booting')` — the line whose job is
      // to prove the document executed at all.
      expect(FACE_PAGE_HTML).toMatch(
        /<link rel="stylesheet"[^>]*styles\.css"[\s\S]{0,80}media="print"/,
      );
    });

    it("should preload every module it imports, at exactly the URL it imports", () => {
      // A correspondence check, not a comment. A preload whose URL differs from
      // the import specifier by one character is a second download dressed as a
      // head start, and it would look completely fine in the source.
      const imported = [...FACE_PAGE_HTML.matchAll(/await import\(\s*'([^']+)'/g)].map(
        (match) => match[1],
      );
      const preloaded = [...FACE_PAGE_HTML.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map(
        (match) => (match[1] ?? "").replaceAll("&amp;", "&"),
      );

      expect(imported).toHaveLength(3);
      for (const specifier of imported) {
        expect(preloaded).toContain(specifier);
      }
    });

    it("should still import them one at a time", () => {
      // Parallel DOWNLOAD is the fix; parallel EVALUATION is the WKWebView bug
      // Adjutant already measured. Gathering these imports must not come back
      // as an optimisation later — the call, not the word, which the comment at
      // the import site names on purpose.
      expect(FACE_PAGE_HTML).not.toMatch(/Promise\.all\s*\(/);
      expect([...FACE_PAGE_HTML.matchAll(/await import\(/g)]).toHaveLength(3);
    });
  });

  /**
   * The camera fence, RUN rather than read.
   *
   * This is the one piece of the page whose failure mode is a session that
   * costs money and shows him nothing, so it is the one piece worth executing
   * in a test instead of matching against its own source. A `toMatch` here
   * would pass on a fence that rejects every call, which is precisely the
   * defect these tests exist to catch.
   *
   * The fence is lifted out of the rendered document and run against a stub
   * `navigator`, so what is exercised is the code that actually ships.
   */
  describe("the camera fence", () => {
    interface FenceRun {
      /** Constraints the fence passed INWARD, in order. Empty if it never delegated. */
      readonly inner: unknown[];
      /** `[state, detail]` for every report the fence made. */
      readonly told: readonly (readonly [string, string])[];
      readonly getUserMedia: (constraints: unknown) => Promise<unknown>;
    }

    /** Install the shipped fence over a stub `getUserMedia` and hand back the seams. */
    function installFence(inner: (constraints: unknown) => Promise<unknown>): FenceRun {
      const start = FACE_PAGE_HTML.indexOf("(function fenceTheCamera() {");
      expect(start, "the fence must still be in the page").toBeGreaterThan(-1);
      const end = FACE_PAGE_HTML.indexOf("\n    })();", start);
      expect(end, "the fence must still be a self-contained IIFE").toBeGreaterThan(start);
      const source = FACE_PAGE_HTML.slice(start, end + "\n    })();".length);

      const seen: unknown[] = [];
      const told: (readonly [string, string])[] = [];
      const devices = {
        getUserMedia(constraints: unknown) {
          seen.push(constraints);
          return inner(constraints);
        },
      };
      const navigatorStub = { mediaDevices: devices } as Record<string, unknown>;

      // `describeErr` is a sibling of the fence in the page; the fence calls it,
      // so the harness supplies the same contract rather than a copy of it.
      const run = new Function(
        "navigator",
        "tell",
        "MediaStream",
        "describeErr",
        `${source}\n return navigator.mediaDevices.getUserMedia;`,
      ) as (
        n: unknown,
        t: (s: string, d?: string) => void,
        m: unknown,
        d: (e: unknown) => string,
      ) => (constraints: unknown) => Promise<unknown>;

      const getUserMedia = run(
        navigatorStub,
        (state: string, detail?: string) => told.push([state, detail ?? ""] as const),
        class FakeMediaStream {
          getTracks(): unknown[] {
            return [];
          }
        },
        (err: unknown) => String((err as Error)?.name ?? "Error"),
      );

      return { inner: seen, told, getUserMedia };
    }

    /** What `DeviceManager.getDevices('videoinput')` asks for, verbatim. */
    const VIDEO_ONLY = { video: true, audio: false };

    it("should never reject a video-only request, because a guard must not fail the session", async () => {
      // The regression. It used to answer this with a `NotAllowedError`, which
      // is OUR code deciding a connection fails — over a capability the page
      // does not use. `getDevices('videoinput')` asks exactly this way.
      const fence = installFence(() => Promise.reject(new Error("must not be reached")));

      await expect(fence.getUserMedia(VIDEO_ONLY)).resolves.toBeDefined();
    });

    it("should open no camera when it answers a video-only request", async () => {
      const fence = installFence(() => Promise.reject(new Error("must not be reached")));

      const stream = (await fence.getUserMedia(VIDEO_ONLY)) as { getTracks(): unknown[] };

      // Resolving is only safe because nothing was captured to resolve WITH.
      expect(fence.inner).toHaveLength(0);
      expect(stream.getTracks()).toHaveLength(0);
    });

    it("should keep the audio half when a request asks for both", async () => {
      const granted = { id: "audio-only" };
      const fence = installFence(() => Promise.resolve(granted));

      await expect(fence.getUserMedia({ video: true, audio: { deviceId: "x" } })).resolves.toBe(
        granted,
      );
      expect(fence.inner).toEqual([{ video: false, audio: { deviceId: "x" } }]);
    });

    it("should pass an audio-only request straight through, untouched", async () => {
      const granted = { id: "mic" };
      const fence = installFence(() => Promise.resolve(granted));

      await expect(fence.getUserMedia({ audio: true })).resolves.toBe(granted);
      expect(fence.inner).toEqual([{ audio: true }]);
    });

    it("should report what came BACK, not only what it stripped", async () => {
      // The blind spot that made `camera_blocked` the last word four sessions
      // ever said: the strip was reported and the result was not, so a refusal
      // inside the retried call was indistinguishable from a page that stopped.
      const fence = installFence(() =>
        Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })),
      );

      await expect(fence.getUserMedia({ video: true, audio: true })).rejects.toThrow();

      const states = fence.told.map(([state]) => state);
      expect(states).toContain("camera_blocked");
      expect(states).toContain("failed");
      expect(fence.told.find(([state]) => state === "failed")?.[1]).toContain("NotAllowedError");
    });

    it("should report a refused audio-only request, which it never even strips", async () => {
      // Nothing about this call is the fence's business, and it is still the
      // only place the refusal is visible from.
      const fence = installFence(() =>
        Promise.reject(Object.assign(new Error("no mic"), { name: "NotFoundError" })),
      );

      await expect(fence.getUserMedia({ audio: true })).rejects.toThrow();

      expect(fence.told.map(([state]) => state)).toContain("failed");
    });

    it("should let a refusal keep propagating, so the SDK still sees its own error", async () => {
      // Reporting must observe, never swallow. A fence that absorbed the
      // rejection would leave the SDK waiting on a promise that never settles.
      const refusal = Object.assign(new Error("denied"), { name: "NotAllowedError" });
      const fence = installFence(() => Promise.reject(refusal));

      await expect(fence.getUserMedia({ video: true, audio: true })).rejects.toBe(refusal);
    });
  });

  it("should be reachable without a bearer token", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${FACE_PAGE_PATH}/live`);

    // Deliberate, and the same argument the admin bundle makes: the document
    // holds nothing, and the credential it needs is handed to it by the host
    // that already paid for the session. Gating the shell would mean inventing
    // a second credential to reach the page that consumes the first one — and
    // the `WKWebView` has no device token, which is exactly the point.
    expect(response.status).toBe(200);
  });
});
