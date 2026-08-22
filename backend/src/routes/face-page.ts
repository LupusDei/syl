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
<link rel="stylesheet" href="https://esm.sh/@runwayml/avatars-react/styles.css" />
<link rel="preconnect" href="https://esm.sh" crossorigin />
<link rel="dns-prefetch" href="https://esm.sh" />
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

  /* Fill the screen in PORTRAIT. The SDK's call widget is a 16/9 strip; its
     inner video already does object-fit: cover, so overriding the container to
     the full viewport crops the landscape source to a full-screen portrait.
     (Targeting the SDK's own container is what works — its ::before blur traps
     position: fixed on anything inside it.) */
  #root { position: fixed; inset: 0; z-index: 1; overflow: hidden; }
  #root, #root * { background-color: transparent !important; }
  [data-avatar-call] {
    width: 100vw !important; height: 100vh !important; height: 100dvh !important;
    aspect-ratio: auto !important; max-width: none !important; max-height: none !important;
  }
  [data-avatar-video], [data-avatar-video] > * {
    position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important;
  }
  [data-avatar-video] video, [data-avatar-video] canvas {
    position: absolute !important; inset: 0 !important;
    width: 100% !important; height: 100% !important; object-fit: cover !important;
  }
  /* She looks at him; he is not on camera. No self-view. */
  [data-avatar-user-video] { display: none !important; }

  #status { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2;
    padding: 14px 18px calc(14px + env(safe-area-inset-bottom));
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
  const statusEl = document.getElementById('status');
  const say = (msg, isErr) => { statusEl.innerHTML = msg; statusEl.className = isErr ? 'err' : ''; };

  // Tell the native host what is happening, when there is one. A web view that
  // renders nothing and says nothing is the stalled face this epic forbids, and
  // the host cannot see inside the document.
  const host = (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sylFace) || null;
  const tell = (state, detail) => { try { host && host.postMessage({ state, detail: detail || '' }); } catch (_) {} };

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
  if (!session) {
    say('This page is opened by Syl, and it was opened without a session.', true);
    tell('failed', 'no session');
  } else {
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

    try {
      // SERIALLY, in this order: react first, so react-dom and avatars-react
      // resolve it from cache. Adjutant measured a parallel Promise.all here
      // tripping a WKWebView "Importing a module script failed".
      const React = (await import('https://esm.sh/react@18')).default;
      const { createRoot } = await import('https://esm.sh/react-dom@18/client');
      const { AvatarCall } = await import(
        'https://esm.sh/@runwayml/avatars-react?bundle&deps=react@18,react-dom@18');

      const h = React.createElement;
      root = createRoot(document.getElementById('root'));
      root.render(h(AvatarCall, {
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        avatarId: session.avatarId,
        // Her voice comes out of the phone and his goes in. Nothing else: she
        // has a face and he does not need one, and a camera the feature does
        // not use is a permission prompt nobody should have to answer.
        audio: true,
        video: false,
        onConnected: () => { say(''); tell('connected'); },
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
      tell('failed', String((error && error.message) || error));
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
