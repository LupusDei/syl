/**
 * The path prefix this build is served under.
 *
 * Syl serves the admin at `/admin` from her own origin (`backend/src/routes/
 * admin.ts`), so every route React Router matches sits one segment deeper than
 * the path it is written as. Vite already knows the prefix — it is the `base`
 * the bundle was built with, and it inlines it as `import.meta.env.BASE_URL` —
 * so deriving the router's basename from it means the two cannot drift.
 *
 * Getting this wrong fails quietly, which is why it is a named, tested
 * function rather than a literal: the page loads, the shell renders, and every
 * single route falls through to the not-found view.
 *
 * Shaped like `api/base-url.ts` on purpose — a pure function of the
 * environment, plus one value resolved at module load.
 */

/**
 * Normalise a Vite `BASE_URL` into a React Router `basename`.
 *
 * `BASE_URL` always carries a trailing slash; `basename` must not have one,
 * except for the root where `/` is the only spelling.
 */
export function resolveBasename(base: string | undefined): string {
  const trimmed = (base ?? "").trim();
  if (trimmed === "") return "/";
  const withoutTrailing = trimmed.replace(/\/+$/u, "");
  return withoutTrailing === "" ? "/" : withoutTrailing;
}

/**
 * Resolved once at module load; it cannot change without a reload.
 *
 * Under vitest there is no Vite `base`, so this is `/` and every existing test
 * addresses routes exactly as it did before.
 */
export const ADMIN_BASENAME: string = resolveBasename(
  // Safe: Vite inlines `import.meta.env` at build time as a plain object.
  // `BASE_URL` is declared on `ImportMetaEnv`, which is why this is read the
  // same guarded way `api/base-url.ts` reads `VITE_API_BASE_URL` — the cast
  // keeps this compiling whether or not `vite/client` types are in scope.
  (import.meta.env as unknown as Record<string, string | undefined>)["BASE_URL"],
);
