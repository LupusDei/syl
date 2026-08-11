import { resolve, sep } from "node:path";

import express, { Router, type RequestHandler } from "express";

import { inspectAdminBundle, looksLikeFile } from "../ops/admin-bundle.js";
import { ApiFailure } from "./envelope.js";

/**
 * The web admin, served from Syl's own origin.
 *
 * **Why same-origin rather than a second server.** The phone already reaches
 * Syl over `tailscale serve` on a publicly-trusted certificate, and the admin
 * talks to `/api/v1` with a bearer token. Served from Syl herself there is no
 * CORS to configure, no second certificate to renew, no App Transport Security
 * exception compiled into the iOS app, and `/api/v1` is the same string in the
 * browser, in the app and in production. Every alternative reintroduces one of
 * those — pointing a WebView at the Vite dev server reintroduces all four.
 *
 * **Mount order and mount scope are the load-bearing details.** A single-page
 * app needs a history fallback so that reloading `/admin/jobs` returns the page
 * rather than a 404, and a history fallback is by nature a catch-all. Two
 * things keep it away from the contract:
 *
 *  1. it is mounted *after* `/api/v1` in `createApp`, and
 *  2. it lives inside a router mounted at `/admin`, so Express never dispatches
 *     to it for a URL that does not start with that prefix.
 *
 * The second is the one that matters: ordering is a line that can be moved,
 * scoping is structural. `tests/unit/admin.test.ts` pins both by asking whether
 * `/api/v1/<unknown>` still answers with Syl's JSON envelope.
 *
 * **The bundle is unauthenticated on purpose.** It contains no secrets — the
 * admin asks for a key on load and every request it makes is refused without a
 * bearer token — so gating the shell would only mean inventing a second
 * credential mechanism to reach the page that asks for the first one.
 */

/**
 * Where the admin lives. Must equal the frontend's Vite `base`.
 *
 * Two constants, two languages, two packages, and no compiler can relate them —
 * so `tests/integration/admin-bundle.test.ts` builds the real bundle and checks
 * that every URL its `index.html` asks for begins with this path. A mismatch is
 * red there rather than a blank page on a phone.
 */
export const ADMIN_BASE_PATH = "/admin";

/**
 * The refusal for a build that has no admin in it.
 *
 * Deliberately **not** `NOT_FOUND`. A 404 here is indistinguishable from a
 * mis-mounted route and sends whoever is debugging into the routing code, which
 * is exactly how the missing `.sql` migrations wasted a day. This says the
 * bundle is absent, where it was looked for, and what to run.
 */
export function missingBundleFailure(root: string): ApiFailure {
  return new ApiFailure(
    "INTERNAL",
    `The admin bundle is not present in this build. Run \`npm run build\` (or ` +
      `\`npm run build -w frontend\`) and reload — nothing needs restarting.`,
    { details: { adminDir: root } },
  );
}

export interface AdminRouterOptions {
  /** The directory `vite build` wrote the bundle into. */
  readonly root: string;
}

/**
 * Static files, then the history fallback.
 *
 * Nothing here ends a request it cannot answer: a miss calls `next()` and lands
 * on the service's own terminal 404, so an absent asset is still one of the
 * contract's two envelopes rather than an HTML page.
 */
export function createAdminRouter(options: AdminRouterOptions): Router {
  // Absolute, because `sendFile` refuses a relative path and `SYL_ADMIN_DIR`
  // may well be given as one.
  const root = resolve(options.root);
  const assetsPrefix = `${root}${sep}assets${sep}`;
  const router = Router();

  router.use(
    express.static(root, {
      // The fallback below owns `index.html`, so there is exactly one place
      // that decides what a page request gets and one place that sets its
      // cache headers.
      index: false,
      // A miss must fall through to the fallback, not end the request.
      fallthrough: true,
      setHeaders: (response, filePath) => {
        // Vite puts the content hash in the filename under `assets/`, so those
        // are immutable by construction. Nothing else is, and caching a file
        // whose name never changes is how a rebuilt admin keeps serving last
        // week's JavaScript.
        response.setHeader(
          "Cache-Control",
          filePath.startsWith(assetsPrefix)
            ? "public, max-age=31536000, immutable"
            : "no-store",
        );
      },
    }),
  );

  router.use(serveAdminIndex(root));

  return router;
}

/**
 * The history fallback: any route the SPA owns returns `index.html`.
 *
 * Scoped to the admin's mount path by construction — this handler is only ever
 * reached for a URL under {@link ADMIN_BASE_PATH}.
 */
export function serveAdminIndex(root: string): RequestHandler {
  return (request, response, next) => {
    // A POST to a page is not a page request. Falling through gives it the
    // contract's 404 rather than 200 and a document.
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }
    // A file that `express.static` did not find is missing, not a route. See
    // `looksLikeFile`.
    if (looksLikeFile(request.path)) {
      next();
      return;
    }

    // Checked per request rather than once at mount, so building the admin
    // while the service is running is enough. See `inspectAdminBundle`.
    const bundle = inspectAdminBundle(root);
    if (!bundle.present) {
      next(missingBundleFailure(root));
      return;
    }

    response.setHeader("Cache-Control", "no-store");
    // `root` plus a relative name, NOT the absolute path — and this is a bug
    // that has already been caught rather than a style preference. Given an
    // absolute path, `send` refuses any path containing a dot-directory,
    // because it cannot tell which part of it came from the caller and which
    // from the request. It inspects the whole string, so a bundle living under
    // `~/.syl/admin` — or under an agent worktree in `.claude/` — answers 404
    // with no explanation and looks exactly like a missing file. With `root`
    // set, only the relative part is inspected, which is the part that can
    // actually be hostile.
    response.sendFile("index.html", { root }, (error: unknown) => {
      // A bundle that vanished between the check and the read, or an unreadable
      // file. Only forward if nothing has gone out yet: handing the error
      // handler a response that is already streaming would produce a second set
      // of headers.
      if (error !== undefined && error !== null && !response.headersSent) next(error);
    });
  };
}
