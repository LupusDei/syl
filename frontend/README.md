# frontend

Syl's web admin — Vite + React + TypeScript. Owned by epic `syl-004`.

**This is a development instrument, not a product surface.** Its job is making
the system inspectable while we build it: which jobs ran, what failed, and what
is sitting unconfirmed in the delivery outbox. Optimise for information density
and clarity; polish is not the goal, and neither is Adjutant's CRT aesthetic.

## Commands

```sh
npm run dev -w frontend        # vite dev server on 4211, /api proxied to 4201
npm run build -w frontend
npm test -w frontend
npm run typecheck -w frontend
```

Against the mock instead of the backend — which is how this workspace is meant
to be developed, and what its tests decode:

```sh
npm run mock                                     # 127.0.0.1:4210/api/v1
SYL_API_ORIGIN=http://127.0.0.1:4210 npm run dev -w frontend
```

The dev server is on **4211, not 4210**: `npm run mock` binds 4210 and
`shared/openapi.yaml` names it in `servers[]`, so a dev server there collides
with the thing it is pointed at.

`npm test` and `npm run typecheck` from the repo root cover this workspace too,
and the root run is what CI gates on.

## Layout

```
index.html                 mount point; the palette is stamped here too
src/main.tsx               mount() + the #root entry
src/storage.ts             StorageLike + a localStorage wrapper that cannot throw
src/theme/tokens.ts        the token registry — references only, never values
src/theme/tokens.css       the palettes, swapped by [data-theme]
src/theme/ThemeProvider.tsx  holds the theme name, stamps data-theme
src/auth/api-key-store.ts  read/write/clear the admin API key
src/auth/AuthProvider.tsx  useAuth(): apiKey, signIn, signOut
src/auth/ApiKeyGate.tsx    the whole of the sign-in surface
src/api/base-url.ts        API_BASE_URL, from VITE_API_BASE_URL. Ends at /v1
src/api/authed-fetch.ts    bearer header + URL join. Nothing else — see below
src/api/use-authed-fetch.ts  the above, wired to the stored key and sign-out
src/api/errors.ts          the failure taxonomy + envelope unwrapping
src/api/retry.ts           the backoff policy. Reads only — see below
src/api/client.ts          the typed read client, shapes from @syl/shared/types
src/api/use-admin-client.ts  the client, wired to the stored key
src/api/use-resource.ts    one request's lifecycle: data, error, loading, reload
src/app/nav.ts             the section list, as data
src/app/App.tsx            providers, router, and the route table
src/app/AppLayout.tsx      the chrome
src/app/views.tsx          overview, placeholders, not-found
src/format/time.ts         instants, spans, lateness. Pure
src/format/text.ts         ids, cost, enum names. Pure
src/ui/Badge.tsx           a state chip, coloured by token reference
src/ui/feedback.tsx        Loading / Empty / ErrorNotice
src/features/jobs/         the job and run viewer (syl-004.2.1)
src/features/delivery/     the outbox viewer (syl-004.2.2)
tests/helpers/fixtures.ts  the shared fixtures, read off disk
tests/unit/**              vitest
```

Each viewer keeps its judgements in a `*-model.ts` of pure functions and its
markup thin. "Is this job in trouble", "what does this trigger mean" and "did
this run fire late" are the parts worth testing, and none of them need a DOM.

## Conventions worth keeping

**Design tokens are references, never values.** `tokens.ts` holds
`var(--syl-bg-panel)` strings; the colours live in `tokens.css` under
`[data-theme="…"]`. Swapping the palette is a stylesheet edit and costs no
re-render. `tests/unit/tokens.test.ts` fails if a token is referenced but not
declared, or declared but not referenced — the two files cannot drift.

Adding a theme: extend `THEME_NAMES`, add a row to `THEMES`, add one
`[data-theme="…"]` block. Nothing else.

**Tests are `.test.ts`, not `.test.tsx`.** The root vitest config collects
`{backend,frontend,shared}/tests/**/*.test.ts` and `check-workspaces-tested.mjs`
counts the same pattern, so a `.tsx` test would be silently skipped by CI. Tests
therefore use `createElement as h` instead of JSX.

**DOM tests declare their own environment.** The root runner pins
`environment: "node"` repo-wide, so every test touching the DOM opens with a
`// @vitest-environment jsdom` docblock. Setting it in `vitest.config.ts` here
would work locally and do nothing in CI.

**API types are not written by hand.** They are generated into `shared/` from
`shared/openapi.yaml`. `authed-fetch.ts` is deliberately the transport and
nothing more — no parsing, no error taxonomy, no endpoint helpers; `client.ts`
adds exactly those three things on top, and **describes no payload of its own**.
If a shape looks wrong, it is wrong in `shared/openapi.yaml`; report it there
rather than patching a type here.

**The fixtures are the test data.** `tests/helpers/fixtures.ts` reads
`shared/fixtures/*.json` — the same bytes the mock serves and the Swift suite
decodes. It reads them off disk rather than through `@syl/shared/fixtures`,
because that module resolves paths from `import.meta.url`, which under jsdom is
an `http:` URL and throws before a byte is read.

## The API client

`shared/openapi.yaml` is explicit that **`error.code` is the contract and the
HTTP status is advisory**, so `errors.ts` branches on the envelope and never on
the status line: a `success: false` body is a failure at 200. Three failure
kinds beyond that — `network` (no response at all, retryable, because the
Tailscale extension is torn down when idle), `malformed` (a response that is
not an envelope) and `unknown`.

`retry.ts` retries only what the server marked `retryable`, treats
`retryAfterMs` as a floor that outranks the local cap, and jitters. It applies
to **reads only**: every write in the contract requires an `Idempotency-Key`,
and a retry loop without one turns a timeout into a duplicate. That is why the
client is read-only — a write surface must carry the key before it may reuse
the policy.

## The delivery viewer is the load-bearing one

It is how the never-drop guarantee is *proved* rather than asserted, so it is
built around one distinction the contract is emphatic about: `deliveredAt`
means APNs accepted the request, and **only `ackedAt` — set by the device —
means it arrived**. Apple keeps only the most recent notification per app
while a device is offline, so a night of reminders can collapse into one; a
surface that treated `delivered` as done would show a green screen for a night
the Commander never heard about.

So `state: delivered` is coloured as a *warning*, the standing column says
`unconfirmed` and for how long, the banner leads with the unconfirmed count,
and the default filter is `unacknowledged` — stated in words above the table,
so an empty table is never mistaken for an empty outbox.

## Auth

There is no login round-trip. The operator pastes the admin API key, it is kept
in `localStorage` (origin-scoped, cleared from the header at any time), and it
is sent as `Authorization: Bearer …` on every request. A 401 or 403 calls
`onUnauthorized`, which the shell wires to sign-out — so a revoked key returns
you to the gate instead of leaving you staring at empty panels.
