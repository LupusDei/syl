import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MEMORY_NODE_KINDS } from "../../src/memory/schema.js";

/**
 * The published vocabulary and the stored one are the same vocabulary.
 *
 * `syl-025`. The contract's `MemoryNodeKind` enum sat **four migrations behind**
 * `MEMORY_NODE_KINDS` — missing `place` since `0029`, then `self` and `instruction` —
 * and nothing went red, because the routes validate against the TypeScript constant and
 * no node of a new kind had yet reached a device.
 *
 * **What it was waiting to do is the point.** `MemoryNode.kind` is non-optional in the
 * Swift model, so the first `place` node to reach the phone would have failed the decode
 * of that node, which fails the array, which fails the page. Not one row skipped — the
 * Memory screen, blank, with nothing anywhere reporting a fault. That is `syl-020` in a
 * second enum and `syl-021` in a third costume: a value that is fine everywhere except
 * where it is used.
 *
 * The Swift side is now forward-compatible — an unknown kind decodes to `unrecognised`
 * rather than throwing — because "keep the list complete" is not a property that survives
 * two release trains shipping independently. **This test is the other half**: leniency
 * stops a drift from being fatal, and parity stops it from happening. Without this, the
 * contract silently stops describing the system and the only symptom is a client that
 * quietly cannot see something.
 *
 * Read from the YAML text rather than a generated artefact on purpose: the generated
 * types are produced FROM this file, so asserting against them would compare the
 * contract with itself and pass while the published document was wrong.
 */
describe("the node-kind vocabulary", () => {
  it("should publish exactly the kinds the store can hold", () => {
    const contract = readFileSync("shared/openapi.yaml", "utf8");

    // The `MemoryNodeKind` schema's inline enum, taken from the document itself.
    const declared = /MemoryNodeKind:[\s\S]*?enum: \[([^\]]+)\]/u.exec(contract);
    expect(declared, "MemoryNodeKind is no longer an inline enum in the contract").not.toBeNull();

    const published = (declared?.[1] ?? "")
      .split(",")
      .map((kind) => kind.trim())
      .filter((kind) => kind !== "");

    expect([...published].sort()).toEqual([...MEMORY_NODE_KINDS].sort());
  });
});
