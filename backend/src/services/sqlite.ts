import { createRequire } from "node:module";

/**
 * The one place `node:sqlite` is loaded.
 *
 * A static `import ... from "node:sqlite"` does not survive the test runner.
 * Vite decides what counts as a Node builtin from `module.builtinModules`,
 * which omits anything still flagged experimental — and `node:sqlite` is
 * omitted on 22.23.1 even though `module.isBuiltin("node:sqlite")` is `true`.
 * vite-node then strips the `node:` prefix, looks for a package called
 * `sqlite`, finds none, and fails the whole test **file** to load with
 * `Failed to load url sqlite`. That error names neither SQLite nor the module
 * that imported it, and a failed file is not a failed test — under the wrong
 * reporter it is simply absent, which is the exact silent-skip failure
 * `scripts/check-node.mjs` exists to prevent.
 *
 * `createRequire` resolves through Node instead of through the bundler, so the
 * runtime lookup is Node's own and cannot be rewritten by anything in the
 * toolchain. The types still come from `@types/node`, so nothing is weakened:
 * `typeof import("node:sqlite")` is the same declaration a static import would
 * have used.
 *
 * Everything else in the service imports SQLite from here, never directly.
 * Delete this module the release `module.builtinModules` lists `sqlite`.
 */

const loadFromNode = createRequire(import.meta.url);

// Safe assertion: `node:sqlite` is a Node builtin, and the asserted type is
// exactly the declaration TypeScript would apply to a static import of it.
const sqlite = loadFromNode("node:sqlite") as typeof import("node:sqlite");

/** A synchronous SQLite connection. */
export const DatabaseSync = sqlite.DatabaseSync;

/** An open connection. */
export type Database = import("node:sqlite").DatabaseSync;

/** A prepared statement. */
export type Statement = import("node:sqlite").StatementSync;
