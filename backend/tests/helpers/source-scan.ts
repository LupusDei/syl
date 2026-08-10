import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { sourceFiles } from "./sql-tables.js";

/**
 * Reading the source to answer questions no component test can.
 *
 * `syl` has a recurring shape of defect — `syl-1o7`, `syl-c5q`, `syl-md5`,
 * `syl-vls` — where every component is correct, every unit suite is green, and
 * the thing that is missing is a *line of wiring*. `chat-wiring.test.ts` and the
 * last test in `us4-untrusted-content-cannot-act.test.ts` are the guards that
 * came out of those. This module is the same tool, factored out, for the
 * question `syl-009` raises: **which modules can hand a tool surface to a
 * turn?**
 *
 * Everything here strips comments first. That is not tidiness: `harness/
 * reader.ts` spends a paragraph explaining that it runs `--strict-mcp-config`
 * with no `--mcp-config`, so a scanner reading raw text flags the one file whose
 * entire purpose is not to have one. A guard with a false positive against its
 * own star witness is a guard that gets deleted rather than fixed.
 */

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
/** `//` to end of line, but never the `//` in a URL scheme. */
const LINE_COMMENT = /(^|[^:])\/\/[^\n]*/g;

/** A file's source with its comments removed. */
export function codeOf(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}

/** Comments removed from source already in hand. */
export function stripComments(source: string): string {
  return source.replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT, "$1");
}

/**
 * Does this source hand an MCP config to a turn?
 *
 * Keyed on `mcpConfig` — the property name in `TurnOptions` — rather than on the
 * name of whichever module ends up producing the path. That module does not
 * exist yet (`syl-009.3.3` writes it) and could be called anything; the property
 * name is fixed by `harness/session.ts` and is the only door into
 * `--mcp-config`, so anything that attaches an MCP server to a turn has to spell
 * it. A caller assembling argv by hand is caught by the flag itself.
 *
 * Word-boundaried deliberately: `strictMcpConfig` is the opposite instruction —
 * *ignore* ambient MCP — and matching it would make the guard argue against
 * itself.
 */
export function handsAnMcpConfigToATurn(code: string): boolean {
  return /(?<![A-Za-z0-9_])mcpConfig(?![A-Za-z0-9_])/u.test(code) || code.includes("--mcp-config");
}

/** Files under `dir` whose code hands an MCP config to a turn, `dir`-relative. */
export function filesHandingAnMcpConfig(dir: string): readonly string[] {
  return sourceFiles(dir)
    .filter((file) => handsAnMcpConfigToATurn(codeOf(file)))
    .map((file) => file.slice(dir.length))
    .sort();
}

/** Every `from "..."` specifier — covers `import`, `import type` and `export from`. */
const IMPORT_SPECIFIER = /\bfrom\s+"([^"]+)"/gu;

/**
 * Every module reachable from `entry` by following relative imports.
 *
 * The transitive closure, not the direct imports: a tool surface reached two
 * modules down is exactly as reachable as one imported at the top, and rather
 * more likely to be how it actually happens.
 */
export function importClosure(entry: string): readonly string[] {
  const seen = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const match of codeOf(file).matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1];
      if (specifier === undefined || !specifier.startsWith(".")) continue;
      // Source imports carry the emitted `.js` extension; the file on disk is
      // the `.ts` beside it.
      const target = resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"));
      if (existsSync(target)) queue.push(target);
    }
  }

  return [...seen].sort();
}
