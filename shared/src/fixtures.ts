import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FIXTURES_DIR } from "./spec.js";

/**
 * The shared fixtures.
 *
 * These are the artefact that actually prevents drift. A spec both sides
 * ignore is decoration; a fixture both sides must decode is a gate — Adjutant
 * shipped iOS models that disagreed with its own backend responses and paid
 * for it with two critical bugs found late.
 *
 * They are plain JSON on disk, not TypeScript objects, for exactly one reason:
 * the Swift suite has to read the same bytes. Anything expressed in a language
 * only one side speaks is not a shared fixture.
 *
 * `manifest.json` is the index. Both suites read it, so neither can quietly
 * skip a file.
 */

/** How a fixture file relates to the schema that governs it. */
export type FixtureEnvelope =
  /** The file is a full `{ success: true, data }` body; `schema` types the `data`. */
  | "ok"
  /** The file *is* the named schema — a request body, an error envelope, a frame. */
  | "raw";

export interface FixtureEntry {
  /** Path relative to `shared/fixtures/`, e.g. `ws/presence_speaking.json`. */
  readonly file: string;
  /** The `components.schemas` name this fixture must validate against. */
  readonly schema: string;
  readonly envelope: FixtureEnvelope;
  /** Why this fixture exists. Read it before changing the file. */
  readonly summary: string;
}

/** A fixture's name: its path with the `.json` dropped, e.g. `http/health.ok`. */
export type FixtureName = string;

interface Manifest {
  readonly fixtures: readonly FixtureEntry[];
}

let manifest: Manifest | undefined;

function load(): Manifest {
  if (manifest === undefined) {
    manifest = JSON.parse(readFileSync(join(FIXTURES_DIR, "manifest.json"), "utf8")) as Manifest;
  }
  return manifest;
}

/** Every fixture, in manifest order. The contract test iterates this. */
export function fixtureEntries(): readonly FixtureEntry[] {
  return load().fixtures;
}

/** Every fixture name. */
export function fixtureNames(): readonly FixtureName[] {
  return load().fixtures.map((entry) => nameOf(entry.file));
}

/** Frozen list form, for callers that want it as a constant. */
export const FIXTURE_NAMES: readonly FixtureName[] = Object.freeze(fixtureNames());

function nameOf(file: string): FixtureName {
  return file.replace(/\.json$/, "");
}

/** Raw bytes of a fixture file, by manifest-relative path. */
export function readFixtureFile(file: string): string {
  return readFileSync(join(FIXTURES_DIR, file), "utf8");
}

/**
 * A fixture with its manifest entry.
 *
 * Throws — and lists what is available — rather than returning undefined. A
 * mock route silently serving `undefined` is a worse failure than a crash on
 * startup, because the squad building against it debugs their own client
 * first.
 */
export function loadFixture(name: FixtureName): FixtureEntry & { readonly body: unknown } {
  const entry = load().fixtures.find((candidate) => nameOf(candidate.file) === name);
  if (entry === undefined) {
    throw new Error(
      `No fixture named ${JSON.stringify(name)}. Available:\n  ${fixtureNames().join("\n  ")}`,
    );
  }
  return { ...entry, body: JSON.parse(readFixtureFile(entry.file)) as unknown };
}

/**
 * A fixture's body — exactly the bytes that go on the wire, envelope included.
 *
 * This is what the mock server serves and what a client decodes, so a test
 * using it is testing the real shape rather than a convenient subset.
 */
export function fixture(name: FixtureName): unknown {
  return loadFixture(name).body;
}
