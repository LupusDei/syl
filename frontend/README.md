# frontend

Syl's web admin — Vite + React + TypeScript. Owned by epic `syl-004`.

**This is a development instrument, not a product surface.** Its job is making
the system inspectable while we build it: which jobs ran, what failed, and what
is sitting unconfirmed in the delivery outbox. Optimise for information density
and clarity; polish is not the goal, and neither is Adjutant's CRT aesthetic.

## Commands

```sh
npm run dev -w frontend        # vite dev server on 4210, /api proxied to 4201
npm run build -w frontend
npm test -w frontend
npm run typecheck -w frontend
```

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
src/api/base-url.ts        API_BASE_URL, from VITE_API_BASE_URL
src/api/authed-fetch.ts    bearer header + URL join. Nothing else — see below
src/api/use-authed-fetch.ts  the above, wired to the stored key and sign-out
src/app/nav.ts             the section list, as data
src/app/App.tsx            providers, router, and the route table
src/app/AppLayout.tsx      the chrome
src/app/views.tsx          overview, placeholders, not-found
tests/unit/**              vitest
```

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
nothing more — no parsing, no error taxonomy, no endpoint helpers. The typed
admin client is `syl-004.1.2` and the viewers are `syl-004.2.*`.

## Auth

There is no login round-trip. The operator pastes the admin API key, it is kept
in `localStorage` (origin-scoped, cleared from the header at any time), and it
is sent as `Authorization: Bearer …` on every request. A 401 or 403 calls
`onUnauthorized`, which the shell wires to sign-out — so a revoked key returns
you to the gate instead of leaving you staring at empty panels.
