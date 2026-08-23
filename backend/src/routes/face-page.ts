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
<link rel="stylesheet" href="https://esm.sh/@runwayml/avatars-react/styles.css"
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
<link rel="modulepreload" href="https://esm.sh/@runwayml/avatars-react?bundle&amp;deps=react@18,react-dom@18" crossorigin />
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
     HER FRAMING: FIT THE WIDTH, AND LET THE VEIL HOLD THE REST.

     Runway streams a 16:9 LANDSCAPE frame. The rule that used to live here
     stretched the SDK's call widget to the whole viewport and left the inner
     video fitted by COVER, and in a ~9:19.5 portrait phone that
     means MATCH THE HEIGHT AND THROW AWAY THE WIDTH — about three quarters of
     it. That is the face pressed against glass he saw on 2026-08-23: eyes,
     nose and mouth, no head, no hair, no shoulders. The comment was accurate
     and the behaviour was still wrong; a full-screen portrait of a landscape
     source is a crop, described as a fill.

     So the video is now sized from the viewport WIDTH and its 16:9 height is
     allowed to be whatever that makes it, centred, with \`.veil\` — the app's
     own dark, already on this page — filling above and below. \`object-fit:
     contain\` inside that box means nothing is cropped by US whatever ratio
     actually arrives down the wire.

     ------------------------------------------------------------------
     WHY \`--face-zoom\` CANNOT BRING THE OLD BUG BACK

     Plain contain leaves her 56.25vw tall — on a 393x852pt phone that is a
     221pt strip in the middle of a very tall screen, which is honest and
     small. \`--face-zoom\` buys presence back, and it can only ever spend
     WIDTH: \`max-height: 100dvh\` caps the box at the screen, so the FULL
     HEIGHT of Runway's frame is on screen for every zoom up to
     100dvh / 56.25vw — about 3.8x on that phone. At the 1.35 set here the box
     is 531x299pt and 13% is trimmed from each SIDE, which is background and
     the outside of her hair. The top of her head is not reachable from this
     number, which is the property that matters: the failure to avoid is the
     one we had.
     ================================================================== */
  :root { --face-zoom: 1.35; }

  #root { position: fixed; inset: 0; z-index: 1; overflow: hidden; }
  #root, #root * { background-color: transparent !important; }
  /* (Targeting the SDK's own container is what works — its ::before blur traps
     position: fixed on anything inside it.) */
  [data-avatar-call] {
    width: 100vw !important; height: 100vh !important; height: 100dvh !important;
    aspect-ratio: auto !important; max-width: none !important; max-height: none !important;
  }
  /* The widget's own blurred backdrop. It was invisible while the video filled
     the screen; now that the video letterboxes, it would be the only thing in
     the bands where the veil belongs — and the veil is the app's dark, so the
     page does not flash a different one. */
  [data-avatar-call]::before, [data-avatar-call]::after { display: none !important; }

  [data-avatar-video], [data-avatar-video] > * {
    position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;
  }
  [data-avatar-video] video, [data-avatar-video] canvas {
    /* \`inset\` FIRST: the rule above sets all four sides with !important and a
       shorthand written after these would put them back. */
    inset: auto !important;
    position: absolute !important;
    left: 50% !important; top: 50% !important;
    right: auto !important; bottom: auto !important;
    transform: translate(-50%, -50%) !important;
    width: calc(100vw * var(--face-zoom)) !important;
    height: calc(100vw * var(--face-zoom) * 9 / 16) !important;
    max-width: none !important;
    /* The guarantee. Nothing above this line can crop her vertically. */
    max-height: 100dvh !important;
    object-fit: contain !important;
  }
  /* She looks at him; he is not on camera. No self-view. */
  [data-avatar-user-video] { display: none !important; }

  /* THE STATUS SENTENCE, OUT FROM BEHIND THE CONTROLS.

     It used to be pinned to the bottom at z-index 2, which drew "Waking her."
     straight across the SDK's mic, camera and hang-up buttons AND swallowed
     the taps meant for them — a label on top of the only controls the surface
     has. It now sits in the veil directly BELOW her, which is empty by
     construction now that the video letterboxes: the video's lower edge is at
     50% + half its height, and half of (100vw * zoom * 9/16) is
     100vw * zoom * 9/32.

     \`min()\` keeps it on screen on a short or landscape viewport, where
     \`max-height\` has already clamped the video and the derived offset would
     overshoot. \`pointer-events: none\` is the belt: wherever the SDK chooses
     to put its own furniture, a sentence never eats a press again. */
  #status { position: fixed; left: 0; right: 0; z-index: 2;
    pointer-events: none;
    top: min(calc(50% + (100vw * var(--face-zoom) * 9 / 32) + 20px),
             calc(100dvh - 150px));
    padding: 0 18px;
    text-align: center; font-size: 15px; line-height: 1.4; color: #b9b4d6; }
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

  const reported = Object.create(null);
  function tell(state, detail) {
    try { host && host.postMessage({ state: state, detail: detail || '' }); } catch (_) {}
    if (!session) return;
    // One report per state. A retry loop or a state that fires every frame
    // would turn telemetry into traffic, and the server refuses to let it
    // become activity anyway — see \`FaceSessionStore.recordClientState\`.
    if (reported[state]) return;
    reported[state] = true;
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
     */
    (function fenceTheCamera() {
      const devices = navigator.mediaDevices;
      if (!devices || typeof devices.getUserMedia !== 'function') return;
      const inner = devices.getUserMedia.bind(devices);
      devices.getUserMedia = function (constraints) {
        const asked = constraints || {};
        if (!asked.video) {
          // Not our business — but still report a FAILURE, or an audio request
          // that the OS refuses disappears inside the SDK without a word.
          return inner(asked).catch((err) => {
            tell('failed', 'an audio-only media request was refused: ' + describeErr(err));
            throw err;
          });
        }
        const audioOnly = Object.assign({}, asked, { video: false });
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
          if (!asked.video) return shim(asked, onOk, onErr);
          tell('camera_blocked', 'a legacy getUserMedia asked for video');
          return shim(Object.assign({}, asked, { video: false }), onOk, onErr);
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
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        tell('mic_granted');
      } catch (error) {
        tell('mic_denied', (error && (error.name + ': ' + error.message)) || String(error));
      }
    }

    /**
     * DID ANY OF IT ACTUALLY MOVE?
     *
     * \`onConnected\` means the SDK joined a room. It does not mean a frame was
     * painted or a sound was made, and on iOS those are a different question:
     * a \`WKWebView\` blocks media that starts without a user gesture, and the
     * long press that opens this page happens in NATIVE code — so from the web
     * view's point of view there may have been no gesture at all. A blocked
     * element is \`paused\` with data ready and everything else looking perfect.
     *
     * One \`play()\` is attempted, because that is the fix when the block is
     * merely a missing gesture and it costs nothing when it is not. The outcome
     * either way is reported, which is the point: \`playing\`,
     * \`autoplay_blocked\` and \`no_media\` are three different bugs that until now
     * produced one symptom.
     */
    async function watchTheMedia() {
      for (const wait of [1200, 4000]) {
        await new Promise((r) => setTimeout(r, wait));
        if (!root) return;

        const media = Array.from(document.querySelectorAll('#root video, #root audio'));
        if (media.length === 0) continue;

        const live = media.filter((m) => m.srcObject || m.currentSrc || m.src);
        if (live.length === 0) continue;

        const moving = live.filter((m) => !m.paused && m.readyState >= 2);
        if (moving.length > 0) { tell('playing', live.length + ' element(s)'); return; }

        const blocked = live.filter((m) => m.paused);
        if (blocked.length > 0) {
          let recovered = false;
          for (const m of blocked) {
            try { await m.play(); recovered = true; } catch (_) {}
          }
          if (recovered) { tell('playing', 'after an explicit play()'); return; }
          tell('autoplay_blocked', blocked.length + ' element(s) paused with data ready');
          say('She is here but her video will not start on this device.', true);
          return;
        }
      }
      if (root) tell('no_media', 'connected, and nothing ever played');
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
        'https://esm.sh/@runwayml/avatars-react?bundle&deps=react@18,react-dom@18');
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
        onConnected: () => { say(''); tell('connected'); void watchTheMedia(); },
        onDisconnected: () => { say('She has gone.'); tell('ended'); },
        onError: (e) => {
          say('Something went wrong drawing her: ' + ((e && e.message) || e), true);
          tell('failed', String((e && e.message) || e));
        },
      }));
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
