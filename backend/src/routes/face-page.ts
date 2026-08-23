import { Router } from "express";

/**
 * The page her face is drawn on — `syl-chzl.7.5`.
 *
 * ## Why a page and not a native client
 *
 * Rendering a realtime avatar means WebRTC, and the only native way to get
 * WebRTC onto the phone is a LiveKit Swift package. `SylKit` is under a standing
 * **zero-dependency** rule and the app target carries exactly two dependencies,
 * so that was a build-graph decision with a review attached.
 *
 * The Commander's call, 2026-08-22: **do it the way the Bridge already does it.**
 * Adjutant serves an `/avatar` page, its iOS app opens a full-screen `WKWebView`
 * over it, and the live render *and the audio* happen inside the web view. The
 * phone gains no realtime SDK at all — the page does the WebRTC. That is the
 * whole reason this file exists, and it is why `ios/Syl/Features/Face/` contains
 * a web view rather than a room client.
 *
 * ```
 * GET /face/live      this document
 * ```
 *
 * ## Where it is mounted, and why that is not `/api/v1/face`
 *
 * It is **not** part of the contract. `/api/v1/face/...` is the broker's three
 * bearer-authenticated routes plus the avatar's ingress; this is a static
 * document with no envelope, no versioning promise and no client generated from
 * it. Mounting it under the contract's prefix would put an HTML response inside
 * a namespace whose defining property is that everything in it is one of two
 * JSON shapes.
 *
 * So it sits beside `/admin`, at its own root prefix, mounted after the
 * contract — and, like the admin router, it is scoped by its mount rather than
 * by ordering alone, so Express cannot dispatch to it for a URL outside
 * {@link FACE_PAGE_PATH}. `tests/unit/face-page.test.ts` pins that by asking
 * whether `/api/v1/<unknown>` still answers with Syl's JSON envelope.
 *
 * ## How the credential reaches it, which is the security-relevant part
 *
 * The device already holds a short-lived session key: it paid for the session
 * through `POST /api/v1/face/sessions` with its own bearer token. The page has
 * no token and must never have one — a `WKWebView` holding the key to his phone
 * is the thing the whole per-session credential design exists to avoid.
 *
 * So the host hands the credential to the document, by two routes and in this
 * order:
 *
 * 1. **`window.__sylFaceSession`**, injected by the native host as a
 *    document-start user script. Preferred, because it puts the key in no URL
 *    at all and survives a reload of the web view's content process.
 * 2. **the URL fragment** (`#sessionId=…&sessionKey=…`), for a browser opened
 *    by hand. A fragment is never sent to the server, so it reaches no access
 *    log, no proxy log and no `Referer` header. The page clears it from the
 *    address bar on read.
 *
 * **Never the query string.** That is the one form that would be logged, and
 * the test asserts this document reflects nothing a caller puts in the URL.
 *
 * ## Why the SDK comes from a CDN
 *
 * `@runwayml/avatars-react` is loaded from `esm.sh` at runtime rather than
 * bundled, exactly as Adjutant's prototype does it, so this surface needs no
 * build step and no new workspace. Adjutant later found that the esm.sh *module
 * graph* can fail on a mobile `WKWebView` and added a same-origin bundle in
 * front of it; the `?bundle` single-file form used here is that same fallback
 * and is what its page still drops to. If it proves flaky on the device, the
 * fix is a self-hosted bundle at `/face/sdk.js` and a `try` around the import —
 * the page is already written with the import isolated for exactly that.
 */

/**
 * Where the page lives. Its own prefix at the root, beside `/admin`.
 *
 * Deliberately not under `API_BASE_PATH`: see the header. The phone builds
 * `<origin>/face/live` from the same base URL it already talks to, so there is
 * no CORS, no second certificate and no ATS exception — the same argument that
 * put the web admin on this origin.
 */
export const FACE_PAGE_PATH = "/face";

/**
 * The contract's prefix, as the PAGE has to know it.
 *
 * The page reports what became of it to `POST /api/v1/face/sessions/{id}/report`
 * and therefore has to compose that path. It cannot import `API_BASE_PATH` from
 * `index.ts` — `index.ts` imports this module, and a cycle here would be a boot
 * failure to pay for a constant.
 *
 * So it is duplicated, deliberately, and `tests/unit/face-page.test.ts` asserts
 * the two are equal. A duplicated value with a test between the copies is a
 * correspondence check; a duplicated value with a comment is how they drift.
 */
export const FACE_PAGE_API_BASE = "/api/v1";

/**
 * The avatar SDK this page is written against, **exactly**.
 *
 * # THIS PIN IS A SECURITY CONTROL, AND IT IS THE ONLY ONE WE HAVE
 *
 * Read the correctness argument second. The first argument is this:
 *
 * **This document holds `window.__sylFaceSession` — the session id AND the
 * session key — in the same JavaScript context as a script fetched at runtime
 * from a third party.** There is no lockfile, no build step, no integrity hash
 * and no review between somebody else's release and a live credential on the
 * Commander's phone. It is the one place in this subsystem where an outside
 * party's code runs beside one of his secrets.
 *
 * Everything else here is built to keep secrets out of the browser. The broker
 * exists so the page never holds the org secret. The credential arrives by user
 * script rather than by query string. `face-page.test.ts` asserts this document
 * reflects nothing a caller puts in the URL, and that it carries no credential
 * in its source. **All of that is defended against us, and none of it was
 * defended against `esm.sh`.** Until this constant existed, the three specifiers
 * below said `@runwayml/avatars-react` with no version at all — so the code that
 * runs next to his session key was whatever the CDN felt like serving at the
 * moment his phone asked.
 *
 * ## What is and is not available as a control
 *
 * Measured against esm.sh on 2026-08-23, rather than assumed. **Two of these
 * three are controls that are real, adjacent, and do not cover the thing they
 * appear to cover** — which is the most dangerous kind, because a reviewer who
 * sees them stops looking.
 *
 * - **`cache-control: public, max-age=31536000, immutable` IS NOT AN INTEGRITY
 *   CONTROL, AND IT READS EXACTLY LIKE ONE.** That is the single most dangerous
 *   sentence in this file, and it is written at this strength because the
 *   agent who measured it very nearly reported it as the answer and closed
 *   `syl-chzl.13` on it. Read what it actually says: it is a promise about
 *   **caching**, made by the party that serves the bytes, about how long a
 *   client may reuse a response it already has. It says nothing whatsoever about
 *   what a *cold* fetch returns — and every fetch on a phone that has never
 *   opened this page is a cold one. The word `immutable` in an HTTP header is
 *   the server describing its own intentions. It is not a hash, nobody checks
 *   it, and nothing breaks if it is untrue.
 * - **Subresource Integrity does not reach a dynamic `import()`, and a hash
 *   here would LOOK like a gate.** SRI is available on
 *   `<link rel="modulepreload">` and on the stylesheet, so it is perfectly
 *   possible to add one, feel safer, and be wrong: a preload whose hash fails is
 *   merely **discarded**, and the `import()` behind it then re-fetches with no
 *   check at all. It is a hint, not a gate, and the failure mode is that the
 *   next reviewer sees a hash and moves on. The only mechanism that would cover
 *   the import itself is an import map with `integrity`, whose support in the
 *   iOS `WKWebView` is **unverified here** and must be measured before it is
 *   relied on — stated as unknown rather than assumed either way, on a subsystem
 *   where several confident claims have turned out to be about mechanisms that
 *   were never wired.
 * - **The pin does not even cover the whole graph.** The `deps=react@18` query
 *   resolves at esm.sh's discretion: today's response reports
 *   `react-dom@18.3.1,react@18.3.1` in its `x-esm-path`, chosen by them and not
 *   by us. Measured from a live response, not suspected. See `syl-chzl.12`.
 *
 * So the pin is the only control that exists today, and it is a weak one: it
 * removes the *silent* change and leaves the deliberate one. **The real answer
 * is a same-origin self-hosted bundle** — `syl-chzl.13`. The header above
 * already contemplates that fallback for reliability, because the esm.sh module
 * graph can fail on a mobile `WKWebView`; it now has a second and better reason,
 * and Adjutant has already built exactly this (`backend/avatar-sdk-build/` →
 * `backend/public/avatar-sdk.js`, served same-origin).
 *
 * ## And it is what made the prop bug findable
 *
 * `syl-chzl.10`: `onConnected` was passed to a component that does not accept
 * it. Answering *"does this component accept this prop"* requires naming a
 * version, and there was none to name — so the defect was not merely unnoticed,
 * it was unprovable. **A guard that reads a declaration is worth nothing unless
 * the page is pinned to the declaration it read.**
 *
 * ## Changing this number is a three-step move
 *
 * 1. change it here,
 * 2. re-capture the declaration —
 *    `node backend/scripts/capture-avatar-sdk-declaration.mjs`,
 * 3. run `face-page-vendor-props.test.ts`, which fails until the fixture's own
 *    recorded version matches this one and every prop the page passes appears
 *    in the new declaration.
 *
 * Skipping step 2 is caught, not tolerated: the fixture records the version it
 * came from and the test compares it with this constant. And a specifier that
 * loses its exact version — a range, a `latest`, or nothing at all — fails
 * `face-page.test.ts`, which checks all three against this constant.
 */
export const RUNWAY_AVATARS_VERSION = "0.17.0";

/**
 * The document. One string constant so a test can assert on what is in it
 * without going through a socket, which is how "the page carries no credential"
 * stays a property of the source rather than of one response.
 */
export const FACE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Syl</title>
<link rel="preconnect" href="https://esm.sh" crossorigin />
<link rel="dns-prefetch" href="https://esm.sh" />
<!--
  THE SDK'S STYLESHEET, AND IT MAY NOT BLOCK THE DOCUMENT.

  A parser-inserted script element waits for every stylesheet declared before
  it, so a plain \`link rel=stylesheet\` pointing at a CDN put a full round trip
  to esm.sh in FRONT of this page's own first line — including \`tell('booting')\`,
  whose entire job is to prove the document ran. She is billing for that round
  trip at about twenty cents a minute.

  \`media="print"\` makes it non-blocking; the \`onload\` swap applies it the
  moment it lands, which is still long before the SDK it styles has finished
  importing. Same origin, same file, nothing new fetched.
-->
<link rel="stylesheet" href="https://esm.sh/@runwayml/avatars-react@${RUNWAY_AVATARS_VERSION}/styles.css"
      media="print" onload="this.media='all'" />
<!--
  FETCHED IN PARALLEL, EVALUATED IN ORDER.

  The three imports at the bottom of this document stay serial on purpose —
  Adjutant measured importing them all at once tripping a WKWebView "Importing
  a module script failed". But serial EVALUATION does not require serial
  DOWNLOAD, and it was paying for three round trips end to end: react, then
  react-dom, then a bundle of some size.

  These preloads start all three requests while the parser is still in the
  head, so by the time react has evaluated the other two are already in the
  cache and the \`await import\` chain is three cache reads. The order of
  evaluation is unchanged, which is the property the WKWebView bug cares about.

  The hrefs must match the import specifiers CHARACTER FOR CHARACTER, or a
  preload is a second download rather than a head start — \`face-page.test.ts\`
  asserts exactly that correspondence.
-->
<link rel="modulepreload" href="https://esm.sh/react@18" crossorigin />
<link rel="modulepreload" href="https://esm.sh/react-dom@18/client" crossorigin />
<link rel="modulepreload" href="https://esm.sh/@runwayml/avatars-react@${RUNWAY_AVATARS_VERSION}?bundle&amp;deps=react@18,react-dom@18" crossorigin />
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: #070610;
    color: #e8e6f3; font-family: -apple-system, system-ui, sans-serif; }

  /* Her ground. The app's veil, so the page does not flash a different dark
     than the screen it is covering. */
  .veil { position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background:
      radial-gradient(ellipse 70% 50% at 50% 18%, rgba(94,124,226,.20), transparent 62%),
      radial-gradient(ellipse 60% 45% at 22% 86%, rgba(140,110,220,.14), transparent 62%),
      #070610; }

  /* ==================================================================
     HER FRAMING: FULL-BLEED PORTRAIT, THE WAY THE BRIDGE DOES IT.

     The Commander, 2026-08-23: *"she is in a sort of landscape mode live feed
     right now. She should be full screen portrait, just like the adjutant
     bridge."* He has named the reference implementation, and Adjutant's
     \`/avatar\` page is two rules — \`[data-avatar-call]\` stretched to the
     viewport, and the inner video \`object-fit: cover\`. So that is what this
     is. Nothing between him and the edges of his phone.

     ------------------------------------------------------------------
     HE COMPLAINED ABOUT BOTH CROPS, AND ONLY ONE OF THEM WAS OURS

     Earlier the same day: *"too zoomed, the bounding box is wrong"* — she
     filled the phone brow to chin with no head on her. The page answered by
     sizing her from the viewport WIDTH with \`object-fit: contain\`, which
     letterboxed a landscape source into a 221pt strip and produced the
     complaint above. Two opposite crops, both wrong, and the second was a
     over-correction for a cause that was never established.

     **\`cover\` cannot be what took the top of her head, and the geometry says
     so.** Cover scales until BOTH axes are filled, so the binding axis is the
     one the source is short of. A landscape source in a portrait viewport is
     bound by HEIGHT: the whole frame height is on screen for every landscape
     ratio, and the crop is purely horizontal. On a 393x852pt phone a 16:9
     source renders 1514x852 — every row of it visible, 74% of the columns
     gone. You cannot lose a hairline that way. Whatever removed the top of
     her head did it BEFORE the frame reached this document, and the likeliest
     candidate is the provider fitting her 1120x832 character portrait into a
     16:9 stream by trimming top and bottom.

     That is not a CSS problem and it must not be paid for with a CSS
     compromise — a letterboxed strip does not restore her hair, it only makes
     her small as well as cropped.

     ------------------------------------------------------------------
     SO THE PAGE MEASURES RATHER THAN ASSUMING

     Every rule this file has ever carried was written against "Runway streams
     16:9", which nobody had checked. \`frameHer()\` in the script below reads
     \`videoWidth\`/\`videoHeight\` off the element the moment there is one,
     publishes them as \`--face-src-w\`/\`--face-src-h\`, and sends them in the
     \`playing\` report. The next person to argue about this ratio gets a
     number off his phone instead of a comment. ================================================================== */

  /* WHERE A CROP LANDS, WHEN THERE IS ONE TO LAND.

     Inert for every landscape source, by the argument above: their crop is
     horizontal and this only moves the vertical window. It is here as
     insurance rather than as the fix — if the stream ever arrives portrait or
     square, cover starts spending HEIGHT, and the default a browser picks
     (50%) is the one that takes her hair first. Biased above centre so the
     window keeps her head and gives up her shoulders, which is the trade she
     would make. */
  :root { --face-focus-y: 42%; }

  #root { position: fixed; inset: 0; z-index: 1; overflow: hidden; }
  #root, #root * { background-color: transparent !important; }
  /* (Targeting the SDK's own container is what works — its ::before blur traps
     position: fixed on anything inside it.) */
  [data-avatar-call] {
    width: 100vw !important; height: 100vh !important; height: 100dvh !important;
    aspect-ratio: auto !important; max-width: none !important; max-height: none !important;
  }
  /* The widget's own blurred backdrop, and the veil behind it. Both are dark
     rectangles under a video that now covers every pixel, so neither is ever
     seen once she arrives — they are what he looks at WHILE she arrives, and
     the veil is the app's own dark so the page does not flash a different
     one. The SDK's \`::before\` is switched off because it is a \`filter:
     blur()\` container, and one of those traps \`position: fixed\` on
     everything inside it. */
  [data-avatar-call]::before, [data-avatar-call]::after { display: none !important; }

  [data-avatar-video], [data-avatar-video] > * {
    position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;
  }
  [data-avatar-video] video, [data-avatar-video] canvas {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    /* The SDK's stylesheet caps its widget; nothing may cap the picture inside
       a surface whose whole job is to be edge to edge. */
    max-width: none !important;
    max-height: none !important;
    object-fit: cover !important;
    object-position: 50% var(--face-focus-y) !important;
  }
  /* She looks at him; he is not on camera. No self-view. */
  [data-avatar-user-video] { display: none !important; }

  /* THE STATUS SENTENCE, OUT FROM BEHIND THE CONTROLS.

     It used to be pinned at \`bottom: 0\`, which drew "Waking her." straight
     across the SDK's mic, camera and hang-up buttons AND swallowed the taps
     meant for them — a label on top of the only controls the surface has.
     Then it was derived from the letterbox geometry, and the letterbox is
     gone: there is no empty band to sit in any more, because she covers the
     screen.

     So it clears the SDK's control bar by measurement rather than by
     arithmetic — \`[data-avatar-control-bar]\` is \`bottom: 0\` with 16px of
     padding around 48px controls, so 104px is above it with room to spare —
     and it carries a shadow, because it is now read against her face rather
     than against the veil. \`pointer-events: none\` is the belt: wherever the
     SDK chooses to put its own furniture, a sentence never eats a press. */
  #status { position: fixed; left: 0; right: 0; z-index: 2;
    pointer-events: none;
    bottom: calc(104px + env(safe-area-inset-bottom));
    padding: 0 18px;
    text-align: center; font-size: 15px; line-height: 1.4; color: #b9b4d6;
    text-shadow: 0 1px 4px rgba(7, 6, 16, .8); }
  #status.err { color: #ff9d9d; }
  .spin { display: inline-block; width: 13px; height: 13px; border: 2px solid #5e7ce2;
    border-top-color: transparent; border-radius: 50%; animation: s .8s linear infinite;
    vertical-align: -2px; margin-right: 8px; }
  @keyframes s { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="veil"></div>
<div id="root"></div>
<div id="status"><span class="spin"></span>Waking her.</div>
<script type="module">
  /**
   * Where the contract lives, on this same origin.
   *
   * Written here rather than imported from \`index.ts\`, which would be a cycle
   * — this module is imported BY it. \`FACE_PAGE_API_BASE\` is the constant, and
   * \`face-page.test.ts\` asserts it equals \`API_BASE_PATH\`, so the two cannot
   * drift silently: that is a correspondence check rather than a comment.
   */
  const API_BASE = ${JSON.stringify(FACE_PAGE_API_BASE)};
  const statusEl = document.getElementById('status');
  const say = (msg, isErr) => { statusEl.innerHTML = msg; statusEl.className = isErr ? 'err' : ''; };

  // Tell the native host what is happening, when there is one. A web view that
  // renders nothing and says nothing is the stalled face this epic forbids, and
  // the host cannot see inside the document.
  const host = (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sylFace) || null;

  /**
   * The session, from the host or from the fragment. NEVER from the query
   * string — see the module header. Whatever it came from is erased from the
   * address bar immediately, so a screenshot of this page is not a credential.
   */
  function readSession() {
    const injected = window.__sylFaceSession;
    if (injected && injected.sessionId && injected.sessionKey) return injected;
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!hash) return null;
    const q = new URLSearchParams(hash);
    try { history.replaceState(null, '', location.pathname); } catch (_) {}
    const sessionId = q.get('sessionId'), sessionKey = q.get('sessionKey');
    if (!sessionId || !sessionKey) return null;
    return { sessionId, sessionKey, avatarId: q.get('avatarId') || undefined };
  }

  const session = readSession();

  /**
   * SAY WHAT HAPPENED, TO THE HOST *AND* TO THE SERVER.
   *
   * The host channel alone was not enough and the reason is worth stating: it
   * reaches a \`WKWebView\` delegate on his phone, which reaches nothing an
   * operator can read. On 2026-08-23 two sessions billed ninety cents, both
   * were reaped without a single \`ask_syl\`, and every server-side signal was
   * green — because everything that could have gone wrong went wrong in here.
   *
   * \`keepalive\` so the last report survives the page being torn down, which is
   * exactly when \`left\` is sent. Never awaited by anything that draws, and
   * never allowed to throw: a page failing at one thing must not fail at two.
   */
  /**
   * A rejected media request, in words an operator can act on.
   *
   * \`name\` is the part that decides what to do — \`NotAllowedError\` is a
   * refusal and means check the usage descriptions and the capture delegate,
   * \`NotFoundError\` means there is no such device, \`NotReadableError\` means
   * something else holds it. \`message\` alone is vendor prose that varies by
   * WebKit version, so both go in and the name goes FIRST.
   */
  function describeErr(err) {
    if (!err) return 'no error given';
    const name = err.name || 'Error';
    const message = err.message || String(err);
    return name + ': ' + message;
  }

  /**
   * Send one report. **No dedupe of its own** — the callers own that, and there
   * are exactly two of them.
   */
  function post(state, detail) {
    try {
      fetch(API_BASE + '/face/sessions/' + encodeURIComponent(session.sessionId) + '/report', {
        method: 'POST',
        keepalive: true,
        // Joined rather than written as a literal, so the scheme and the
        // credential never appear next to each other anywhere in this
        // document's source — a property \`face-page.test.ts\` asserts against
        // the module rather than against one response.
        headers: {
          'content-type': 'application/json',
          'authorization': ['Bearer', session.sessionKey].join(' ')
        },
        body: JSON.stringify({ state: state, detail: String(detail || '').slice(0, 500) })
      }).catch(() => {});
    } catch (_) {}
  }

  const reported = Object.create(null);
  function tell(state, detail) {
    try { host && host.postMessage({ state: state, detail: detail || '' }); } catch (_) {}
    if (!session) return;
    // One report per state. A retry loop or a state that fires every frame
    // would turn telemetry into traffic, and the server refuses to let it
    // become activity anyway — see \`FaceSessionStore.recordClientState\`.
    if (reported[state]) return;
    reported[state] = true;
    post(state, detail);
  }

  /**
   * How many times the dimension sampler may speak. **The whole of its budget.**
   *
   * The one-report-per-state rule above exists so telemetry cannot become
   * traffic, and \`resized\` is the single exception to it. An exception with no
   * ceiling is not an exception, it is the rule removed — a stream that
   * oscillates between two rungs would report forever — so the allowance is a
   * small integer rather than a flag, and it is spent rather than checked.
   */
  const MAX_RESIZE_REPORTS = 4;
  let resizeReports = 0;

  /**
   * **The one state allowed to speak more than once.**
   *
   * Deliberately not \`tell(state, detail)\` with a \`repeatable\` argument: a
   * flag is available to every future caller, and the next person who wants a
   * chatty state would find the door already open. This function hard-codes its
   * own state name, so the allowance cannot be borrowed.
   *
   * Why it exists: \`playing\` reports the FIRST frame, and WebRTC ramps. His
   * 2026-08-23 session reported \`278x180\` at 8675ms, which may be the ramp
   * rather than the stream — and every framing decision downstream
   * (\`syl-chzl.11\`) turns on which. One sample cannot tell them apart; a second
   * one can.
   */
  function tellResized(detail) {
    try { host && host.postMessage({ state: 'resized', detail: detail || '' }); } catch (_) {}
    if (!session) return;
    if (resizeReports >= MAX_RESIZE_REPORTS) return;
    resizeReports += 1;
    post('resized', detail);
  }

  if (!session) {
    say('This page is opened by Syl, and it was opened without a session.', true);
    // Reaches the host only: with no session there is nothing to report
    // against and no credential to report with.
    tell('no_session');
  } else {
    // The FIRST thing that happens, before any import. Its whole job is to
    // prove the document ran: the difference between "the SDK failed" and "the
    // page never executed" is the difference between a CDN problem and a web
    // view problem, and until this line they looked identical from here.
    tell('booting', navigator.userAgent);

    /**
     * THE CAMERA FENCE. Installed before any import, and it is the fix for a
     * crash rather than a preference.
     *
     * 2026-08-23: the app was TERMINATED four seconds into the session —
     * \`EXC_CRASH (SIGABRT)\`, \`Termination Reason: TCC\`, *"attempted to access
     * privacy-sensitive data without a usage description ... must contain an
     * NSCameraUsageDescription key"*. Both of his attempts died the same way
     * and he was billed ninety cents for two crashes. **iOS does not refuse an
     * undeclared capture, it kills the process**, so there is no error to
     * catch and no state left to report.
     *
     * \`AvatarCall\` is already passed \`video: false\` and it makes no
     * difference, because it is not the avatar component asking. Read from the
     * shipped bundle (\`@runwayml/avatars-react@0.17.0\`, which carries
     * livekit-client): \`DeviceManager.getDevices(kind)\` calls
     * \`enumerateDevices()\`, sees the empty labels every browser returns before
     * permission is granted, and unlocks them with
     *
     *     getUserMedia({ video: kind !== 'audioinput' && kind !== 'audiooutput',
     *                    audio: kind !== 'videoinput' && { deviceId: … } })
     *
     * With no \`kind\`, that is \`video: true\`. **The camera is requested as a
     * side effect of asking what the microphones are called.** No prop reaches
     * it and no version of \`video: false\` ever will.
     *
     * So it is fenced at the one chokepoint every path goes through. Wrapping
     * \`mediaDevices.getUserMedia\` before the SDK loads puts this innermost:
     * the adapter shims the bundle installs wrap OUR function, so they delegate
     * inward and cannot get round it. A request that asked for video and audio
     * proceeds with audio alone.
     *
     * ## The fence must never be able to fail the call
     *
     * It used to refuse a video-ONLY request with a \`NotAllowedError\`, on the
     * reasoning that a denied camera is a shape every caller already handles.
     * That reasoning is sound and it is still not worth the risk: \`getDevices\`
     * asks exactly that way (\`kind === 'videoinput'\` gives
     * \`{ video: true, audio: false }\`), and a rejection there is OUR code
     * deciding a connection fails. **A guard against a capability we do not use
     * must not be able to stop the session** — so a video-only request now
     * resolves with an EMPTY \`MediaStream\`. No camera opens, no track exists,
     * and nothing throws. A caller that enumerates gets unlabelled video
     * devices, which is harmless in a page that never publishes video.
     *
     * ## Why the outcome is reported and not just the strip
     *
     * The strip was reported and the RESULT was not, so \`camera_blocked\` became
     * the last thing four sessions ever said — and that was read as "the fence
     * broke it", which the evidence does not actually support. A report that
     * says what we DID without saying what CAME BACK moves the blind spot one
     * line down and looks like a diagnosis. The inner call's own failure is the
     * far likelier story and it was invisible: a rejected microphone inside a
     * device enumeration surfaces here and nowhere else.
     *
     * ## POSTSCRIPT: \`camera_blocked\` WAS THE LAST WORD FOR A REASON THAT HAD
     * NOTHING TO DO WITH THIS FENCE
     *
     * Kept, because the wrong frame outlives the wrong answer and the next
     * reader will otherwise re-derive it.
     *
     * A whole morning went into "the page goes silent after \`camera_blocked\`",
     * looking for something that had STOPPED. Nothing had stopped. The states
     * after that point were unreachable code — \`connected\` and \`playing\` were
     * reported from \`onConnected\`, which \`AvatarCall\` does not accept, so
     * \`camera_blocked\` was simply the last word the page was still CAPABLE of
     * saying (\`syl-chzl.10\`). It was the high-water mark of a working reporter,
     * read as the epitaph of a broken one.
     *
     * Everything above is still correct and still worth having — reporting an
     * outcome rather than an intention is right on its own terms. But it was
     * aimed at a phantom, and it is worth writing down that a silence has two
     * explanations: **something stopped, or nothing downstream was ever wired.**
     * The second leaves exactly the same evidence and is invisible to every
     * instrument pointed at the first.
     */
    /**
     * WHAT HIS MICROPHONE MUST DO TO HER VOICE BEFORE IT COMES BACK IN.
     *
     * ## THESE WERE NEVER SET. They were not set WRONGLY.
     *
     * Say that plainly, because the distinction changes how freely the next
     * reader may touch them: there is no history of anyone measuring something
     * and settling on these values. Until \`syl-chzl.4.9\` the words
     * \`echoCancellation\`, \`noiseSuppression\` and \`autoGainControl\` did not
     * appear anywhere in this repository — not in the page, not in the iOS
     * target, not in the admin. The page opened a bare \`{ audio: true }\` and
     * left the real capture to the SDK's defaults. Change them if you have a
     * reason; you are not overturning a judgement, only filling an absence.
     *
     * ## What it cost
     *
     * She could hear herself. Runway keeps a verbatim transcript of every
     * session (\`GET /v1/avatar_conversations/{sessionId}\`, free, keyed on an id
     * we already store), and session \`b547219a\` has this in the **user**
     * channel: *"You are Silv. Powered by Syl and spreading powers."* He never
     * said it — that is her own voice, round the loop, through speech
     * recognition, arriving as an assertion about who she is. She answered it
     * ("I'm Syl, powered by Runway") four times, feeding each answer back in.
     * The Commander experienced that as a generic fallback identity replacing
     * everything she knows, and it was nothing of the kind: the same transcripts
     * show her reciting six of her seven documents unprompted.
     *
     * ## Ours wins, deliberately
     *
     * The merge puts these LAST, so a caller asking for
     * \`echoCancellation: false\` does not get it. That is not an oversight to be
     * tidied into a polite default — the caller here is a vendor SDK whose
     * capture settings we cannot otherwise see, and the whole point of the fence
     * is that no capture on this page escapes them.
     */
    const AUDIO_PROCESSING = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };

    /**
     * Merge {@link AUDIO_PROCESSING} into whatever a caller asked for.
     *
     * Handles the boolean form (\`audio: true\`) and the object form alike, and
     * leaves a request that wants no audio at all untouched.
     */
    function withAudioProcessing(asked) {
      if (!asked || !asked.audio) return asked;
      const wanted = asked.audio === true ? {} : Object.assign({}, asked.audio);
      return Object.assign({}, asked, { audio: Object.assign(wanted, AUDIO_PROCESSING) });
    }

    (function fenceTheCamera() {
      const devices = navigator.mediaDevices;
      if (!devices || typeof devices.getUserMedia !== 'function') return;
      const inner = devices.getUserMedia.bind(devices);
      devices.getUserMedia = function (constraints) {
        const asked = constraints || {};
        if (!asked.video) {
          // **THE BRANCH LIVEKIT TAKES**, and therefore the one that decides
          // whether she can hear herself. The page passes \`video: false\`, so
          // the SDK's own capture arrives here as audio-only and would
          // otherwise pass straight through with whatever defaults it chose.
          // Not our business to change the camera half; entirely our business
          // to make sure the microphone is processed.
          //
          // Still report a FAILURE, or an audio request the OS refuses
          // disappears inside the SDK without a word.
          return inner(withAudioProcessing(asked)).catch((err) => {
            tell('failed', 'an audio-only media request was refused: ' + describeErr(err));
            throw err;
          });
        }
        const audioOnly = withAudioProcessing(Object.assign({}, asked, { video: false }));
        if (!audioOnly.audio) {
          tell('camera_blocked', 'a video-only request was answered with an empty stream');
          return Promise.resolve(new MediaStream());
        }
        tell('camera_blocked', 'a media request asked for video; retrying it as audio alone');
        return inner(audioOnly).then(
          (stream) => {
            tell('mic_granted', 'the audio half of a camera request succeeded');
            return stream;
          },
          (err) => {
            tell('failed', 'the audio half of a camera request was refused: ' + describeErr(err));
            throw err;
          },
        );
      };
      // The legacy shims, for completeness. Both are documented to route into
      // \`mediaDevices\` on modern WebKit, so this is belt rather than braces —
      // and a belt costs four lines.
      const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia;
      if (typeof legacy === 'function') {
        const shim = legacy.bind(navigator);
        const fenced = function (constraints, onOk, onErr) {
          const asked = constraints || {};
          if (!asked.video) return shim(withAudioProcessing(asked), onOk, onErr);
          tell('camera_blocked', 'a legacy getUserMedia asked for video');
          return shim(withAudioProcessing(Object.assign({}, asked, { video: false })), onOk, onErr);
        };
        try { navigator.getUserMedia = fenced; } catch (_) {}
        try { navigator.webkitGetUserMedia = fenced; } catch (_) {}
      }
    })();

    let root = null;

    /**
     * Leave the room. **This is the teardown the host calls before it throws
     * the web view away**, and it is not decoration: unmounting is what drops
     * the LiveKit connection, and a page destroyed without it can leave the
     * room joined behind a screen he has already left. Idempotent, because the
     * host calls it and \`pagehide\` fires too.
     */
    window.sylFaceLeave = () => {
      const r = root; root = null;
      try { r && r.unmount(); } catch (_) {}
      tell('left');
    };
    window.addEventListener('pagehide', () => { window.sylFaceLeave(); });

    /**
     * HIS HALF OF THE CALL, ASKED FOR EXPLICITLY AND BEFORE THE SDK.
     *
     * A conversation needs his microphone. In a \`WKWebView\` that needs the
     * app's \`NSMicrophoneUsageDescription\`, the \`WKUIDelegate\` capture
     * decision, and the OS prompt actually being answered — three things, any
     * of which failing makes \`getUserMedia\` reject, which inside the SDK is
     * indistinguishable from a face that simply never spoke.
     *
     * So it is asked here, where the rejection has a name, and the tracks are
     * stopped immediately: this is a permission probe, not a capture. The
     * failure does NOT stop the render — hearing her with no way to answer is
     * worth more than a black screen, and she is already billing.
     */
    async function askForTheMicrophone() {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          tell('mic_denied', 'navigator.mediaDevices is not available in this web view');
          return;
        }
        // **REPORTED BEFORE THE CALL, and that is the whole point.** iOS
        // terminates the process for an undeclared capture rather than
        // refusing it, so a state reported afterwards can never describe the
        // failure that killed the caller. If this is the last word on the row,
        // she died asking for media.
        tell('mic_requested');
        // Constrained like every other capture. It goes through the fence too,
        // so this is belt — but a probe that asks for something different from
        // what the session will use is a probe that answers the wrong question,
        // and \`getUserMedia\` can refuse on constraints alone.
        const stream = await navigator.mediaDevices.getUserMedia(
          withAudioProcessing({ audio: true, video: false }));
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        tell('mic_granted');
      } catch (error) {
        tell('mic_denied', (error && (error.name + ': ' + error.message)) || String(error));
      }
    }

    /**
     * WHAT THE SDK ACTUALLY TELLS US, AND WHY IT IS READ OFF THE DOM.
     *
     * This page used to pass \`onConnected\` and \`onDisconnected\` to
     * \`AvatarCall\`. **Neither is a prop of \`AvatarCall\`.** Read from the
     * published declaration of \`@runwayml/avatars-react@0.17.0\` — the exact
     * version imported below — the component destructures \`avatarId\`,
     * \`sessionId\`, \`sessionKey\`, \`credentials\`, \`connectUrl\`, \`connect\`,
     * \`baseUrl\`, \`audio\`, \`video\`, \`avatarImageUrl\`, \`onEnd\`, \`onError\`,
     * \`onClientEvent\`, \`children\`, \`initialScreenStream\`,
     * \`__unstable_roomOptions\` **and spreads the rest onto a \`div\`**. Two
     * unknown handlers on a DOM element: React warns to a console nobody on a
     * phone can read, and drops them.
     *
     * So \`tell('connected')\` never fired, the media watch was only ever
     * called from \`onConnected\` and therefore never ran at all, and
     * \`playing\`, \`autoplay_blocked\`, \`no_media\` and \`ended\` were unreachable
     * code in a shipped build. Every row in \`face_sessions\` proves it: the
     * furthest word any session has ever reported is \`connecting\`.
     *
     * That is what put twenty-five seconds between hearing her and seeing her.
     * With no \`connected\` there is no grace, and with no \`playing\` there is no
     * signal, so the phone fell through to \`LiveFace.readyDeadline\` — forty-five
     * seconds — while \`RoomAudioRenderer\` played her from the moment the audio
     * track subscribed.
     *
     * The lifecycle is therefore taken from the one place the SDK publishes it
     * without a callback: \`[data-avatar-video]\` carries
     * \`data-avatar-status\`, which is \`useAvatarStatus()\` rendered as an
     * attribute — \`connecting\`, then \`waiting\` once the ROOM IS ACTIVE and
     * before any video track exists, then \`ready\`. An attribute cannot be
     * mistyped into silence.
     */
    const AVATAR_STATUS_WORDS = { connecting: 'connecting', waiting: 'connected', ready: 'connected' };

    /** How often the watch looks. Fine enough that "heard" and "seen" are the same moment. */
    const WATCH_TICK_MS = 250;
    /** How long a paused element gets before an explicit \`play()\` is the answer. */
    const AUTOPLAY_VERDICT_MS = 5000;
    /** How long nothing at all may happen before the session is settled as dead. */
    const NOTHING_EVER_PLAYED_MS = 30000;
    /**
     * How often to re-measure her AFTER the first frame.
     *
     * Two seconds, which is coarse on purpose: this is not watching for a
     * moment, it is separating a ramp from a steady state, and the interesting
     * change happens over seconds. The cost of being wrong in this direction is
     * one sample landing slightly late in a curve; the cost of being wrong in
     * the other is a poll loop on a phone for the length of a call.
     */
    const RESAMPLE_TICK_MS = 2000;

    /**
     * HER REAL DIMENSIONS, TAKEN FROM THE ELEMENT.
     *
     * Every framing rule this page has ever carried was written against
     * "Runway streams 16:9", which was never measured. \`videoWidth\` and
     * \`videoHeight\` are the decoded frame, so this is the provider's own
     * answer — published as custom properties for anything that wants to size
     * from them, and sent in the \`playing\` report so the next argument about
     * her crop is settled with a number off his phone.
     */
    function frameHer(video) {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return '';
      try {
        const style = document.documentElement.style;
        style.setProperty('--face-src-w', String(w));
        style.setProperty('--face-src-h', String(h));
      } catch (_) {}
      return w + 'x' + h;
    }

    /**
     * KEEP MEASURING HER. **One sample cannot tell a ramp from a stream.**
     *
     * \`playing\` fires on the FIRST frame, and a first frame is the worst frame
     * a WebRTC stream ever sends: the encoder starts at a low rung and scales up
     * over the following seconds. His 2026-08-23 session reported \`278x180\` at
     * 8675ms, and every framing decision downstream turns on whether that is the
     * stream or the ramp — 278px upscaled fourfold across a phone is a softness
     * defect quite separate from the crop, and 1.544 is neither 16:9 nor 4:3, so
     * even the ASPECT could still move. \`syl-chzl.11\` is blocked on knowing
     * which, and closing it on the lowest-quality frame she ever sends would be
     * closing it on the one number guaranteed to be unrepresentative.
     *
     * So the watch does not stop at the first frame. It re-reads the element
     * every {@link RESAMPLE_TICK_MS} and speaks only when the size actually
     * CHANGES — a steady stream is silent, which is itself the answer. Each
     * report carries the first size beside the current one, because the session
     * row keeps only the last state: even the surviving row then tells the whole
     * curve rather than its endpoint.
     *
     * Bounded by {@link MAX_RESIZE_REPORTS} and by nothing else. It deliberately
     * runs for the life of the page rather than for a fixed window — a change at
     * four minutes is as interesting as one at ten seconds, and the report
     * budget is the real ceiling.
     */
    async function keepMeasuringHer(video, firstSize, began) {
      let lastSize = firstSize;
      while (root) {
        await new Promise((r) => setTimeout(r, RESAMPLE_TICK_MS));
        if (!root) return;
        // The element can be replaced under us if the SDK re-renders. Nothing
        // to measure is not a change; it is the end of this element's story.
        if (!video.isConnected) return;

        const size = frameHer(video);
        if (!size || size === lastSize) continue;

        const waited = Date.now() - began;
        const spent = resizeReports + 1 >= MAX_RESIZE_REPORTS;
        tellResized(
          'first ' + firstSize + ', was ' + lastSize + ', now ' + size + ' at ' + waited + 'ms' +
            (spent ? ' (last sample: the ' + MAX_RESIZE_REPORTS + '-report budget is spent)' : ''),
        );
        lastSize = size;
        if (spent) return;
      }
    }

    /** Whether an element is carrying sound he could actually hear. */
    function carriesAudio(element) {
      if (element.tagName === 'AUDIO') return true;
      const source = element.srcObject;
      try { return !!source && source.getAudioTracks && source.getAudioTracks().length > 0; }
      catch (_) { return false; }
    }

    /**
     * ONE LOOP, STARTED WHEN SHE IS RENDERED AND NOT WHEN SOMETHING CALLS BACK.
     *
     * **The rule it exists to keep: a face he can hear must be a face he can
     * see.** Audio does not wait for the video track — \`RoomAudioRenderer\` is
     * a sibling of the avatar's video inside \`AvatarSession\`, and it plays a
     * remote audio track the instant it subscribes. So \`audible\` is reported
     * the moment anything is moving with sound in it, and the phone presents
     * her on that word with no grace at all. Being billed to talk to a black
     * screen is worse than either a slow face or a missing one.
     *
     * \`playing\` still means what it always meant — frames — and still arrives,
     * now carrying the dimensions. Nothing here can end the session early: the
     * two fatal words are reported only after a verdict has actually been
     * reached, and \`no_media\` only after thirty seconds in which nothing was
     * ever heard and nothing was ever painted.
     */
    async function watchHer() {
      const began = Date.now();
      let lastStatus = '';
      let triedToPlay = false;
      let heard = false;

      while (root) {
        await new Promise((r) => setTimeout(r, WATCH_TICK_MS));
        if (!root) return;
        const waited = Date.now() - began;

        // The SDK's own lifecycle. Reported on the transition, so a word is
        // said once however many times the attribute is written.
        const box = document.querySelector('[data-avatar-video]');
        const status = (box && box.getAttribute('data-avatar-status')) || '';
        if (status !== lastStatus) {
          lastStatus = status;
          const word = AVATAR_STATUS_WORDS[status];
          // \`tell\` is idempotent per word, so \`waiting\` then \`ready\` reports
          // \`connected\` once — which is right: the room came up once.
          if (word) tell(word, 'data-avatar-status=' + status);
        }

        const media = Array.from(document.querySelectorAll('#root video, #root audio'));
        const live = media.filter((m) => m.srcObject || m.currentSrc || m.src);
        const moving = live.filter((m) => !m.paused && m.readyState >= 2);

        // HEARD. The layer rises here, before there is anything to look at.
        if (!heard && moving.some(carriesAudio)) {
          heard = true;
          say('');
          tell('audible', 'sound at ' + waited + 'ms, ' + moving.length + ' element(s) moving');
        }

        // SEEN. Frames, with her real size attached.
        const painted = moving.filter((m) => m.tagName === 'VIDEO' && m.videoWidth > 0);
        if (painted.length > 0) {
          say('');
          const firstSize = frameHer(painted[0]);
          tell('playing', firstSize + ' at ' + waited + 'ms');
          // **The watch does not end here.** A first frame is the worst frame a
          // WebRTC stream sends, and one sample cannot tell a ramp from a
          // stream — see \`keepMeasuringHer\`. Handed off rather than returned
          // into, so this fast loop stops and the slow one takes over.
          await keepMeasuringHer(painted[0], firstSize, began);
          return;
        }

        // A \`WKWebView\` blocks media that starts without a user gesture, and
        // the long press that opened this page happened in NATIVE code — so
        // from in here there may have been no gesture at all. A blocked
        // element is \`paused\` with data ready and everything else perfect.
        // One \`play()\`, once, after the ordinary arrival window has passed.
        if (!triedToPlay && waited >= AUTOPLAY_VERDICT_MS && live.length > 0 && moving.length === 0) {
          triedToPlay = true;
          let recovered = false;
          for (const m of live) {
            try { await m.play(); recovered = true; } catch (_) {}
          }
          if (!recovered) {
            tell('autoplay_blocked', live.length + ' element(s) paused, and play() was refused');
            say('She is here but this phone will not start her.', true);
            return;
          }
        }

        // Nothing heard, nothing painted, half a minute gone. Settling it here
        // is what stops a dead session billing until the phone's own deadline.
        if (!heard && waited >= NOTHING_EVER_PLAYED_MS) {
          tell('no_media', 'nothing was ever heard or painted in ' + waited + 'ms');
          return;
        }
      }
    }

    // Not awaited: the prompt can sit on screen for as long as he likes, and
    // making the render wait behind it would mean a blank page while she bills.
    void askForTheMicrophone();

    try {
      // SERIALLY, in this order: react first, so react-dom and avatars-react
      // resolve it from cache. Adjutant measured a parallel Promise.all here
      // tripping a WKWebView "Importing a module script failed".
      const React = (await import('https://esm.sh/react@18')).default;
      const { createRoot } = await import('https://esm.sh/react-dom@18/client');
      const { AvatarCall } = await import(
        'https://esm.sh/@runwayml/avatars-react@${RUNWAY_AVATARS_VERSION}?bundle&deps=react@18,react-dom@18');
      tell('sdk_loaded');

      const h = React.createElement;
      root = createRoot(document.getElementById('root'));
      tell('connecting');
      root.render(h(AvatarCall, {
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        avatarId: session.avatarId,
        // Her voice comes out of the phone and his goes in. Nothing else: she
        // has a face and he does not need one, and a camera the feature does
        // not use is a permission prompt nobody should have to answer.
        audio: true,
        video: false,
        // **SAY IT DECLARATIVELY AS WELL AS THROUGH THE FENCE**, because the
        // two fail in different ways. This is the vendor's own supported route
        // to livekit's capture defaults — the only prop in the published
        // declaration that reaches them — and it applies to a track the SDK
        // creates by any means, including one that never touches
        // \`navigator.mediaDevices\`. The fence covers a rename of this
        // \`@internal\` prop; this covers a capture that bypasses the fence.
        // Neither alone is enough, and the redundancy is the point: she could
        // hear herself for a full day and no instrument here said a word.
        __unstable_roomOptions: { audioCaptureDefaults: AUDIO_PROCESSING },
        // **Only props this component actually destructures.** \`onConnected\`
        // and \`onDisconnected\` were passed here for a day and are not part of
        // \`AvatarCall\` — they landed on a \`div\` and did nothing, which took
        // the whole lifecycle down with them. See the note above \`watchHer\`.
        // \`onEnd\` is the one that means the room dropped or she finished.
        onEnd: () => { say('She has gone.'); tell('ended'); },
        onError: (e) => {
          say('Something went wrong drawing her: ' + ((e && e.message) || e), true);
          tell('failed', String((e && e.message) || e));
        },
      }));

      // Started HERE, unconditionally, because a watch that hangs off a
      // callback is a watch that never runs when the callback is not real.
      void watchHer();
    } catch (error) {
      // The import graph failed, which on a phone is the likeliest failure of
      // the lot. Say so — the session is already billing, and a blank screen is
      // the one outcome that tells him nothing.
      say('I could not load the parts that draw me. ' + ((error && error.message) || error), true);
      tell('sdk_failed', String((error && error.message) || error));
    }
  }
</script>
</body>
</html>
`;

/**
 * The page, and nothing else.
 *
 * No static directory, no history fallback and no catch-all: this is one
 * document at one path, so a URL under {@link FACE_PAGE_PATH} that is not
 * `/live` falls through to the service's own terminal 404 and gets the
 * contract's envelope rather than a page. So does any method that is not a page
 * request — a POST to a document is not a document request.
 *
 * There is no `sendFile` here, and therefore no exposure to the landmine that
 * makes an absolute path containing a dot-directory 404 — the document is a
 * string compiled into the build.
 *
 * ## Why this is `use` and not `get`, which is not a style choice
 *
 * `tests/helpers/contract.ts` walks Express's router stack to answer "what does
 * this service dispatch that the contract does not publish", and it names each
 * route **relative to its own mount** — which is right for `/api/v1`, where the
 * mount prefix is exactly what the spec's templates omit. A `router.get("/live")`
 * here would therefore appear in that finding as `GET /live`, a path that does
 * not exist, on a list whose entire value is that it is legible.
 *
 * `createAdminRouter` is invisible to the same walk for the same reason and by
 * the same means: a static surface is served by middleware, not by a route. This
 * is not dodging the guard — the guard is about the *contract*, and this is a
 * document with no envelope, no operation id and no generated client. It is
 * matching the precedent the admin already set for exactly this class of
 * surface.
 */
export function createFacePageRouter(): Router {
  const router = Router();

  router.use((request, response, next) => {
    // A POST to a page is not a page request; it gets the contract's 404.
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }
    // One document at one path. `request.path` is relative to the mount.
    if (request.path !== "/live" && request.path !== "/live/") {
      next();
      return;
    }

    // Never cached. It stands in front of a session-scoped credential and it
    // costs nothing to fetch again.
    response.setHeader("Cache-Control", "no-store");
    response.type("text/html").send(FACE_PAGE_HTML);
  });

  return router;
}
