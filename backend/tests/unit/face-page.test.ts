import type { ApiError } from "@syl/shared";
import { afterEach, describe, expect, it } from "vitest";

import { API_BASE_PATH, createApp } from "../../src/index.js";
import {
  FACE_PAGE_API_BASE,
  FACE_PAGE_HTML,
  FACE_PAGE_PATH,
  RUNWAY_AVATARS_VERSION,
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
    /**
     * The declarations of the rule that sizes her picture, with the comments
     * around it left out.
     *
     * Sliced rather than searched, because this file argues about `cover` and
     * `contain` in prose and a `toContain` over the whole document would be
     * answered by a sentence. The property under test is a property of the
     * RULE.
     */
    function pictureRule(): string {
      const start = FACE_PAGE_HTML.indexOf("[data-avatar-video] video");
      expect(start).toBeGreaterThan(-1);
      return FACE_PAGE_HTML.slice(start, FACE_PAGE_HTML.indexOf("}", start));
    }

    it("should cover the whole phone with her, the way the Bridge does", () => {
      // His words, 2026-08-23: "she is in a sort of landscape mode live feed
      // right now. She should be full screen portrait, just like the adjutant
      // bridge." A letterboxed strip is the thing being removed, so `contain`
      // must be gone from the RULE and not merely outranked later in it.
      const rule = pictureRule();

      expect(rule).toMatch(/object-fit:\s*cover/);
      expect(rule).not.toMatch(/object-fit:\s*contain/);
    });

    it("should let her picture reach every edge, with nothing capping it", () => {
      // The widget is the viewport and the picture is the widget. A `max-width`
      // or `max-height` surviving from the SDK's own stylesheet is how a
      // full-bleed surface quietly becomes a boxed one again.
      const rule = pictureRule();

      expect(rule).toMatch(/width:\s*100%/);
      expect(rule).toMatch(/height:\s*100%/);
      expect(rule).toMatch(/max-width:\s*none/);
      expect(rule).toMatch(/max-height:\s*none/);
      expect(FACE_PAGE_HTML).toMatch(
        /\[data-avatar-call\][^{]*\{[^}]*height:\s*100dvh[^}]*\}/,
      );
    });

    it("should keep her head when a crop has to spend height", () => {
      // Inert for a landscape source — their crop is horizontal — and the
      // whole point is that the page no longer assumes the source is
      // landscape. If the stream ever arrives portrait or square, cover starts
      // spending height, and the browser's default 50% takes her hair first.
      const rule = pictureRule();
      const focus = /--face-focus-y:\s*(\d+)%/.exec(FACE_PAGE_HTML);

      expect(rule).toMatch(/object-position:\s*50% var\(--face-focus-y\)/);
      expect(focus).not.toBeNull();
      expect(Number(focus?.[1])).toBeLessThan(50);
    });

    it("should measure her real size rather than asserting one in CSS", () => {
      // Every framing rule this page has carried was written against "Runway
      // streams 16:9", which nobody had checked. The hardcoded ratio is gone
      // and the element is asked instead — a number off his phone beats a
      // comment, and it is the only thing that can settle the next argument.
      expect(FACE_PAGE_HTML).not.toMatch(/9\s*\/\s*16|16\s*\/\s*9/);
      expect(FACE_PAGE_HTML).toContain("videoWidth");
      expect(FACE_PAGE_HTML).toContain("videoHeight");
      expect(FACE_PAGE_HTML).toContain("--face-src-w");
    });

    it("should report her real size with the frame that proved it", () => {
      // The measurement is worth nothing on the phone alone. `playing` carries
      // it to the session row, which is the only place an operator can read it.
      expect(FACE_PAGE_HTML).toMatch(/tell\('playing',\s*frameHer\(/);
    });

    it("should still hold the app's own dark behind her while she is coming", () => {
      // She covers every pixel once she arrives; this is what he looks at
      // until she does, and it must not be a different dark from the screen
      // the page is drawn over.
      expect(FACE_PAGE_HTML).toContain('<div class="veil">');
      expect(FACE_PAGE_HTML).toMatch(/\[data-avatar-call\]::before[^{]*\{[^}]*display:\s*none/);
    });
  });

  /**
   * **He heard her twenty-five seconds before he could see her.**
   *
   * `AvatarCall` has no `onConnected` and no `onDisconnected` — read from the
   * declaration published with `@runwayml/avatars-react@0.17.0`, the version
   * this page imports. Both were passed anyway, landed in the component's
   * `...props` rest, and were spread onto a `div`. So `connected` never fired,
   * the media watch hung off a callback that did not exist and therefore never
   * ran, and `playing`, `autoplay_blocked`, `no_media` and `ended` were
   * unreachable code in a shipped build.
   *
   * The phone fell through to its forty-five second deadline every time, while
   * `RoomAudioRenderer` played her from the moment the audio track subscribed.
   */
  describe("she must never be audible before she is visible", () => {
    /**
     * The `AvatarCall` element's props, **with the comments stripped**.
     *
     * The comments there name the two dead handlers on purpose, so that nobody
     * puts them back. A test that read them would be answered by the sentence
     * warning against the thing instead of by the thing.
     */
    function renderedProps(): string {
      const start = FACE_PAGE_HTML.indexOf("root.render(h(AvatarCall, {");
      expect(start).toBeGreaterThan(-1);
      return FACE_PAGE_HTML.slice(start, FACE_PAGE_HTML.indexOf("}));", start)).replaceAll(
        /^\s*\/\/.*$/gm,
        "",
      );
    }

    it("should pass no handler the SDK does not destructure", () => {
      // The exact defect, pinned by name. A prop this component does not take
      // is not inert — it is a lifecycle that silently does not happen.
      const props = renderedProps();

      expect(props).not.toContain("onConnected");
      expect(props).not.toContain("onDisconnected");
    });

    it("should learn that she has gone from the handler that actually exists", () => {
      // `onEnd` is what `AvatarSession` calls from LiveKit's `onDisconnected`.
      // Without it `ended` never arrives and a dropped room looks like a slow one.
      const props = renderedProps();

      expect(props).toMatch(/onEnd:\s*\(\)\s*=>/);
      expect(props).toContain("tell('ended')");
    });

    it("should take the room's own lifecycle from the attribute the SDK publishes", () => {
      // `data-avatar-status` is `useAvatarStatus()` rendered onto the DOM:
      // `connecting`, then `waiting` the moment the room is ACTIVE and before
      // any video track exists, then `ready`. An attribute cannot be mistyped
      // into silence the way a prop name can.
      expect(FACE_PAGE_HTML).toContain("data-avatar-status");
      expect(FACE_PAGE_HTML).toMatch(/waiting:\s*'connected'/);
      expect(FACE_PAGE_HTML).toMatch(/ready:\s*'connected'/);
    });

    it("should say she is audible the moment anything with sound is moving", () => {
      // The rule this whole section exists for: a face he can hear must be a
      // face he can see. Audio does not wait for the video track —
      // `RoomAudioRenderer` is a sibling of the avatar's video and plays a
      // remote audio track as soon as it subscribes.
      expect(FACE_PAGE_HTML).toContain("tell('audible'");
      expect(FACE_PAGE_HTML).toContain("carriesAudio");
    });

    it("should start watching when she is rendered, not when something calls back", () => {
      // The structural half of the fix. A watch reached only through a
      // callback is a watch that does not run when the callback is not real,
      // and that is precisely how this failed.
      const script = FACE_PAGE_HTML.slice(FACE_PAGE_HTML.indexOf("root.render(h(AvatarCall"));

      expect(script).toContain("void watchHer();");
      expect(FACE_PAGE_HTML).not.toContain("void watchTheMedia()");
    });

    it("should never call a session dead before it has waited longer than the phone", () => {
      // `no_media` and `autoplay_blocked` settle a session and cost him the
      // press. Now that the watch actually runs, a verdict reached too early
      // would hang up on a face that was merely slow.
      const verdict = /AUTOPLAY_VERDICT_MS\s*=\s*(\d+)/.exec(FACE_PAGE_HTML);
      const nothing = /NOTHING_EVER_PLAYED_MS\s*=\s*(\d+)/.exec(FACE_PAGE_HTML);

      expect(Number(verdict?.[1])).toBeGreaterThanOrEqual(3000);
      expect(Number(nothing?.[1])).toBeGreaterThanOrEqual(20000);
      // And a session that was heard is never declared dead for lack of a
      // picture. She is on screen by then, and closing her mid-sentence
      // because no frame arrived would be worse than a black rectangle.
      expect(FACE_PAGE_HTML).toMatch(/if \(!heard && waited >= NOTHING_EVER_PLAYED_MS\)/);
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

      // **AND EVERY ONE OF THEM CARRIES AN EXACT VERSION.** Extended here rather
      // than asserted separately, because it is the same fact about the same
      // three URLs: what the page fetches, and from where.
      //
      // This half is a SECURITY assertion, not a latency one. The document holds
      // the session id and key in `window.__sylFaceSession`, so whatever these
      // URLs return runs in the same JavaScript context as a live credential on
      // his phone — with no lockfile, no build step and no integrity hash in
      // between. Unpinned, that code was whatever the CDN chose to serve at the
      // moment his phone asked. The pin does not make the fetch trustworthy; it
      // removes the SILENT change and leaves only the deliberate one, which is
      // the whole of what is available until `syl-chzl.13` self-hosts the bundle.
      //
      // A range, a `latest`, a major-only tag or a bare package name all fail
      // here. So does a version that is exact but disagrees with the constant,
      // which is what keeps the captured declaration in
      // `face-page-vendor-props.test.ts` describing the code that actually runs.
      // Anchored on `https://esm.sh/`, so it matches URLs and not the prose.
      // This document names the package in its comments too — the camera fence
      // cites the shipped bundle by version — and an unanchored scan is answered
      // by a sentence about the code instead of by the code. That has now caught
      // itself twice in this file; the rule is that an assertion about a fetch
      // must match the thing that does the fetching.
      const named = [
        ...FACE_PAGE_HTML.matchAll(/https:\/\/esm\.sh\/@runwayml\/avatars-react([^/?"'\s]*)/g),
      ].map((match) => match[1] ?? "");

      // The stylesheet, the preload and the import. Fewer means one of them
      // stopped naming the package and this check quietly covers less.
      expect(named.length).toBeGreaterThanOrEqual(3);
      for (const version of named) {
        expect(version, `every avatars-react URL must name ${RUNWAY_AVATARS_VERSION} exactly`).toBe(
          `@${RUNWAY_AVATARS_VERSION}`,
        );
      }
      expect(RUNWAY_AVATARS_VERSION, "an exact version — no range, no tag").toMatch(
        /^\d+\.\d+\.\d+$/,
      );
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
