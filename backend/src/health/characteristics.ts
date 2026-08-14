import { findCommanderNode } from "../memory/entities.js";
import type { MemoryGraph } from "../memory/graph.js";
import type { HerOwnMemory } from "../memory/remember.js";
import { crossingInstant } from "../memory/weights.js";
import { systemClock, type Clock } from "../services/clock.js";

import { HEALTH_TYPES, isHealthType } from "./contract.js";

/**
 * Date of birth, sex and height: the three things in his Health permissions
 * that are not measurements.
 *
 * `syl-8ys9.4`. Date of birth and sex are HealthKit **characteristics** — a
 * different API entirely (`dateOfBirthComponents()`, `biologicalSex()`), no time
 * series, no watermark, no baseline. Height is a quantity type and behaves the
 * same way: it does not move. Forcing any of the three through the sample
 * pipeline would give each a fabricated `startedAt` and a baseline computed from
 * one row — a deviation detector pointed at a constant, producing noise with a
 * mean, and then telling him about it.
 *
 * So they go where facts go, and this module holds **no reference to the sample
 * store at all**. That is the enforcement: not a rule about what may be written
 * to `health_samples`, but a path that cannot reach it. The reverse fence is
 * held by {@link HEALTH_CHARACTERISTICS} sharing no name with `HEALTH_TYPES` —
 * a name that is not a health type has no unit, no watermark and nothing in
 * `derive.ts` that iterates to it.
 *
 *
 * ## What a characteristic IS, in her terms — `kind: "memory"`, never `fact`
 *
 * The graph marks authorship in two places and they fail differently: the node
 * kind says *whose claim this is*, and an inferred edge's reasoning says *why
 * she holds it*. `fact` is what `extract-apply.ts` files from **his own words**;
 * `memory` is what she worked out. A characteristic is neither of those on its
 * face — a device reported it — and that is exactly the case `health/review.ts`
 * already answered for everything else health puts in the graph:
 *
 * > `kind: "memory"`, never `kind: "fact"`. He told her nothing here — a sensor
 * > did — and filing it as something he asserted is the one failure in this
 * > subsystem that would corrupt what she believes about him.
 *
 * `remember()` is therefore the only write, and it hard-codes the kind. There is
 * no argument at this call site that could make a characteristic into a `fact`,
 * so no later edit to this file can make one by accident.
 *
 * **A HealthKit characteristic may well be something he typed into the Health
 * app himself, and that changes nothing.** It reached her through a device,
 * undated, with no message behind it and no words of his to quote — which is the
 * same wall `memory_provenance` puts up, and for the same reason. A `quote` is
 * DERIVED so that it is evidence rather than a claim; a derived field with
 * nothing to derive from is a lie with a schema.
 *
 * The traceability the kind cannot carry lives in the **prose**, not only on the
 * edge, and that is deliberate. `remember()` resolves `about` against entities
 * that already exist and mints nothing, so a memory naming nobody has no edges —
 * and an inference's reasoning lives on the edge, so it would have nothing to
 * travel on (`syl-1ozc`). Every sentence this module writes therefore **names
 * the reporter in the thought itself**: "Apple Health reports his height as…".
 * A graph with no person node for him still cannot produce a memory that reads
 * as though he said it.
 *
 *
 * ## Precedence: his word outranks a sensor, and she says which one she used
 *
 * He has already told her his birthday. It is in the live graph today, inside
 * his own person node: *"He is Justin Martin, an engineering leader and
 * entrepreneur, born October 8th 1988."* Health may disagree.
 *
 * `SOUL.md`'s ladder settles it — what he said outranks everything below it, and
 * a reading is below it. The requirement that is not obvious is the second half:
 * **she has to be able to say which one she is using.** A silent preference is
 * indistinguishable from not having noticed the conflict, and *"your birthday is
 * X"* said confidently from the wrong source is the kind of small wrongness that
 * erodes trust in everything else she says.
 *
 * So precedence is expressed three times, in three places that fail differently:
 *
 * | where | what it carries |
 * | --- | --- |
 * | {@link AUTHORITIES} | the ORDER, as a value rather than an `if` |
 * | the memory's own text | both values and the one she uses, in her words |
 * | a `contradicts` edge | the disagreement, linked to the node holding his word |
 *
 * The edge is the queryable half: `contradicts` is already in the inferred
 * vocabulary, its reasoning is mandatory, it decays like every other inference,
 * and `POST /memory/edges/{id}/feedback` is one tap if she has it backwards.
 *
 * **Nothing the sensor said is discarded.** Constraint 6's instinct applies
 * whether or not it binds these rows: the losing value is written down beside
 * the winning one, so "Health says otherwise" stays answerable instead of being
 * quietly dropped on the way in.
 *
 *
 * ## Reading his own words is TEXT MATCHING, and it fails in one direction
 *
 * There is no structured record of what he said. His birthday is prose in a
 * `person` node, and that node carries no `memory_provenance` row and no
 * `stated` edge — it predates both. So a structural test for "he asserted this"
 * would miss the one live case this phase exists for, and the matching has to be
 * textual.
 *
 * Two guards make that safe enough to act on:
 *
 * - **Only text that is about HIM is read.** His person node, found by
 *   `findCommanderNode`, plus the `fact` nodes joined to it. His wife's node is
 *   never scanned, so her birthday can never become his.
 * - **A text mentioning another person possessively is discarded whole**
 *   ({@link MENTIONS_ANOTHER}). *"His wife Ela, born April 22nd 1994"* carries
 *   every cue a birthday matcher looks for and is about somebody else. The rule
 *   is blunt on purpose: it also discards a sentence that mentions both their
 *   birthdays, which is the cheap half of the trade.
 *
 * The residual failure is a FALSE NEGATIVE — she does not find a word of his
 * that is there, and reports the sensor as her source. That is a true statement
 * about the value she is holding, which is why this is the direction to fail in.
 * A false positive would have her announce a conflict that does not exist, or
 * worse, use somebody else's number.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The three that are facts rather than measurements.
 *
 * **Disjoint from `HEALTH_TYPES`, and a test asserts it.** `height` is the one
 * that could plausibly be in both — it is a HealthKit quantity type — and being
 * in both is the defect this phase removes: a baseline over a constant on one
 * side, a fact about him on the other, and two answers to one question about the
 * same man.
 */
export const HEALTH_CHARACTERISTICS = ["dateOfBirth", "biologicalSex", "height"] as const;

export type HealthCharacteristic = (typeof HEALTH_CHARACTERISTICS)[number];

/** Whether a value names one of the three. */
export function isHealthCharacteristic(value: unknown): value is HealthCharacteristic {
  return typeof value === "string" && (HEALTH_CHARACTERISTICS as readonly string[]).includes(value);
}

/** What she calls the source when the answer is his own. */
export const HIS_OWN_WORDS = "his own words";

/**
 * What she calls the source when the answer is a reading.
 *
 * A constant rather than a field on the wire. A reporter name supplied by a
 * client is text a client controls, landing verbatim in the document she reads
 * every turn — and there is nothing to learn from it: a characteristic has no
 * recording device, because it is a value held by the Health app itself.
 */
export const REPORTED_BY = "Apple Health";

/**
 * Who outranks whom, most authoritative first.
 *
 * A list rather than a comparison buried in a branch, so the ordering is a value
 * a test can read and a reader can check against `SOUL.md` §"What outranks what"
 * without following control flow.
 */
export const AUTHORITIES = [HIS_OWN_WORDS, REPORTED_BY] as const;

export type Authority = (typeof AUTHORITIES)[number];

/** The relation a disagreement is filed under. Already in the inferred vocabulary. */
export const CONTRADICTS_RELATION = "contradicts";

/** How sure she is that a reading disagrees with him. It is arithmetic, not judgement. */
export const CONTRADICTION_CONFIDENCE = 0.9;

/** The weight a disagreement starts at. Below 1.0 for the same reason `remember.ts` is. */
export const CONTRADICTION_WEIGHT = 0.8;

/** The most one upload may carry. There are three of them; this is generous. */
export const MAX_CHARACTERISTICS_PER_REPORT = 12;

/** How many person nodes are read looking for him. */
const PERSON_SCAN_LIMIT = 200;

/** What was wrong with a report. */
export type CharacteristicErrorKind =
  | "bad_value"
  | "is_a_measurement"
  | "not_a_characteristic"
  | "too_many";

export class CharacteristicError extends Error {
  readonly kind: CharacteristicErrorKind;
  /** The field the failure is about, for the route's `details`. */
  readonly field: string;

  constructor(kind: CharacteristicErrorKind, field: string, message: string) {
    super(message);
    this.name = "CharacteristicError";
    this.kind = kind;
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Reading text that is about him
// ---------------------------------------------------------------------------

/**
 * Somebody else, named the only way this graph ever names them.
 *
 * Every person in his life is introduced possessively — *"his wife"*, *"his
 * son"*, *"his daughter Isla"* — because to the extractor he is the one person
 * who does not need introducing. A text carrying one of these is a claim about
 * that person, whatever else is in it, and is discarded rather than parsed.
 */
const MENTIONS_ANOTHER =
  /\bhis\s+(?:wife|husband|spouse|partner|son|daughter|child|children|kid|kids|mother|mom|mum|father|dad|parent|parents|brother|sister|sibling|siblings|friend|colleague|boss|cousin|niece|nephew|aunt|uncle|grandmother|grandfather)\b/iu;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const MONTH_NAMES = MONTHS.join("|");

/** A birth cue. Without one, a date in the text is some other date. */
const BIRTH_CUE = /\b(?:born|birthday|date\s+of\s+birth|dob)\b/iu;

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/u;
const MONTH_FIRST = new RegExp(
  String.raw`\b(${MONTH_NAMES})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`,
  "iu",
);
const DAY_FIRST = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_NAMES}),?\s+(\d{4})\b`,
  "iu",
);

/**
 * A sex he stated, as opposed to a pronoun.
 *
 * Every sentence about him carries `he`, so the pronoun proves nothing. What is
 * matched is an explicit predication — *"he is male"*, *"his sex is male"* — and
 * nothing else. Declining is the expected answer here far more often than for
 * the other two, and declining is correct: it means she says the reading is her
 * source, which is true.
 */
const STATED_SEX =
  /\b(?:he\s+is|he's|he\s+was|his\s+sex\s+is|sex\s*[:—-]\s*|gender\s*[:—-]\s*|biologically)\s+(?:biologically\s+)?(male|female)\b/iu;

const FEET_INCHES = /(\d{1,2})\s*(?:'|’|ft\b\.?|feet\b|foot\b)\s*(\d{1,2}(?:\.\d+)?)?\s*(?:"|”|''|in\b\.?|inch(?:es)?\b)?/u;
const BARE_INCHES = /(\d{2,3}(?:\.\d+)?)\s*(?:in\b\.?|inch(?:es)?\b)/u;
const CENTIMETRES = /(\d{2,3}(?:\.\d+)?)\s*cm\b/u;
const METRES = /\b(\d(?:\.\d+)?)\s*m\b/u;

function validDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthNumber(name: string): number {
  return MONTHS.indexOf(name.toLowerCase() as (typeof MONTHS)[number]) + 1;
}

function readDateOfBirth(text: string): string | null {
  if (!BIRTH_CUE.test(text)) return null;

  const iso = ISO_DATE.exec(text);
  if (iso !== null) {
    return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }
  const monthFirst = MONTH_FIRST.exec(text);
  if (monthFirst !== null) {
    return validDate(Number(monthFirst[3]), monthNumber(monthFirst[1] ?? ""), Number(monthFirst[2]));
  }
  const dayFirst = DAY_FIRST.exec(text);
  if (dayFirst !== null) {
    return validDate(Number(dayFirst[3]), monthNumber(dayFirst[2] ?? ""), Number(dayFirst[1]));
  }
  return null;
}

function readSex(text: string): string | null {
  const match = STATED_SEX.exec(text);
  return match === null ? null : (match[1] ?? "").toLowerCase();
}

function readHeight(text: string): string | null {
  const feet = FEET_INCHES.exec(text);
  if (feet !== null) {
    return canonicalInches(Number(feet[1]) * 12 + Number(feet[2] ?? 0));
  }
  const inches = BARE_INCHES.exec(text);
  if (inches !== null) return canonicalInches(Number(inches[1]));
  const cm = CENTIMETRES.exec(text);
  if (cm !== null) return canonicalInches(Number(cm[1]) / 2.54);
  const m = METRES.exec(text);
  if (m !== null) return canonicalInches((Number(m[1]) * 100) / 2.54);
  return null;
}

function canonicalInches(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return String(Math.round(value * 100) / 100);
}

// ---------------------------------------------------------------------------
// One characteristic, and everything that is specific to it
// ---------------------------------------------------------------------------

interface CharacteristicSpec {
  /** What she calls it in a sentence. */
  readonly noun: string;
  /** The canonical form of a value the phone reported, or `null` if it is not one. */
  readonly parse: (raw: string) => string | null;
  /** The value as he would say it. */
  readonly render: (value: string) => string;
  /** What he said, read out of one text already known to be about him. */
  readonly read: (text: string) => string | null;
  /** Whether two values are the same answer. */
  readonly same: (his: string, reported: string) => boolean;
  /** What a value has to look like, for the refusal message. */
  readonly shape: string;
}

/** The four values HealthKit's `biologicalSex()` can answer. */
const SEXES = ["female", "male", "other", "notSet"] as const;

/** Two readings of a height within this many inches are the same answer. */
const HEIGHT_TOLERANCE_INCHES = 0.5;

const SPECS: Readonly<Record<HealthCharacteristic, CharacteristicSpec>> = {
  dateOfBirth: {
    noun: "date of birth",
    parse: (raw) => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw.trim());
      return match === null ? null : validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    },
    render: (value) => {
      const [year, month, day] = value.split("-");
      const name = MONTHS[Number(month) - 1] ?? "";
      return `${Number(day)} ${name.charAt(0).toUpperCase()}${name.slice(1)} ${year ?? ""}`;
    },
    read: readDateOfBirth,
    same: (his, reported) => his === reported,
    shape: "an RFC 3339 date, as YYYY-MM-DD",
  },
  biologicalSex: {
    noun: "sex",
    parse: (raw) => {
      const value = raw.trim();
      return (SEXES as readonly string[]).includes(value) ? value : null;
    },
    render: (value) => value,
    read: readSex,
    same: (his, reported) => his === reported,
    shape: `one of ${SEXES.join(", ")}`,
  },
  height: {
    noun: "height",
    parse: (raw) => {
      const value = Number(raw.trim());
      if (!Number.isFinite(value) || value <= 0) return null;
      return canonicalInches(value);
    },
    render: (value) => {
      const total = Math.round(Number(value));
      const feet = Math.floor(total / 12);
      const inches = total % 12;
      return inches === 0 ? `${feet} ft` : `${feet} ft ${inches} in`;
    },
    read: readHeight,
    same: (his, reported) => Math.abs(Number(his) - Number(reported)) <= HEIGHT_TOLERANCE_INCHES,
    shape: "a positive number of inches",
  },
};

/**
 * The canonical form of a value the phone reported.
 *
 * @throws {CharacteristicError} `bad_value`.
 */
export function parseReported(characteristic: HealthCharacteristic, raw: string): string {
  const spec = SPECS[characteristic];
  const value = spec.parse(raw);
  if (value === null) {
    throw new CharacteristicError(
      "bad_value",
      "value",
      `A ${spec.noun} must be ${spec.shape}, got ${JSON.stringify(raw)}. It is refused rather ` +
        `than guessed at: a value nobody can parse is one nobody can compare against what he said.`,
    );
  }
  return value;
}

/** A value as he would say it. */
export function renderCharacteristic(characteristic: HealthCharacteristic, value: string): string {
  return SPECS[characteristic].render(value);
}

/**
 * What he said about one characteristic, read out of one text, or `null`.
 *
 * Exported for its tests: this is the fragile joint, and a matcher that can only
 * be exercised through a graph is a matcher nobody exercises. See the module
 * header for what the guards are for and which direction this fails in.
 */
export function hisWordIn(characteristic: HealthCharacteristic, text: string): string | null {
  if (MENTIONS_ANOTHER.test(text)) return null;
  return SPECS[characteristic].read(text);
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** One characteristic as the phone read it. */
export interface CharacteristicReport {
  readonly characteristic: HealthCharacteristic;
  /** Canonical per characteristic — see {@link parseReported}. */
  readonly value: string;
  /** RFC 3339 UTC. When the phone read it, which is not when this service wrote it. */
  readonly readAt: string;
}

/** What he said, and where it is written down. */
export interface HisWord {
  readonly nodeId: string;
  readonly value: string;
}

/** One characteristic, resolved and filed. */
export interface CharacteristicOutcome {
  readonly characteristic: HealthCharacteristic;
  /** What Health reported, as he would say it. */
  readonly reported: string;
  /** Which of {@link AUTHORITIES} the answer came from. */
  readonly using: Authority;
  /** The canonical value she will use. */
  readonly value: string;
  /** What he said, when she could find it. */
  readonly hisWord: HisWord | null;
  /** `null` when he has never told her, so there is nothing to agree with. */
  readonly agrees: boolean | null;
  /** The sentence she can say when he asks where a number came from. */
  readonly why: string;
  /** The memory this became. */
  readonly nodeId: string;
  readonly created: boolean;
  /** The edge joining the reading to his own word, when they disagree. */
  readonly contradicts: string | null;
  /** Names that matched nothing she knows. Never minted, always reported. */
  readonly unknown: readonly string[];
}

export interface CharacteristicsRecorded {
  readonly outcomes: readonly CharacteristicOutcome[];
}

export interface HealthCharacteristicsOptions {
  readonly graph: MemoryGraph;
  /**
   * Her one write into her own memory.
   *
   * The narrow object rather than the graph, deliberately: `remember()`
   * hard-codes `kind: "memory"` and has no method that supersedes, relabels or
   * mints a person. A characteristic cannot become a `fact` from here because
   * there is no argument that would make one.
   */
  readonly hers: HerOwnMemory;
  readonly clock?: Clock;
}

export class HealthCharacteristics {
  readonly #graph: MemoryGraph;
  readonly #hers: HerOwnMemory;
  readonly #clock: Clock;

  constructor(options: HealthCharacteristicsOptions) {
    this.#graph = options.graph;
    this.#hers = options.hers;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * File what Health reported, resolving it against what he has said.
   *
   * Nothing here writes a measurement, and nothing here can: this object holds
   * no sample store. What it writes is one memory per characteristic, naming the
   * reporter in its own text, plus a `contradicts` edge when the reading and his
   * own words disagree.
   *
   * @throws {CharacteristicError} `too_many`, `not_a_characteristic`,
   * `is_a_measurement`, `bad_value`.
   */
  record(reports: readonly CharacteristicReport[]): CharacteristicsRecorded {
    if (reports.length > MAX_CHARACTERISTICS_PER_REPORT) {
      throw new CharacteristicError(
        "too_many",
        "characteristics",
        `One report may carry at most ${String(MAX_CHARACTERISTICS_PER_REPORT)} characteristics; ` +
          `there are only ${String(HEALTH_CHARACTERISTICS.length)}.`,
      );
    }

    const outcomes: CharacteristicOutcome[] = [];
    for (const report of reports) {
      outcomes.push(this.#one(report));
    }
    return { outcomes };
  }

  #one(report: CharacteristicReport): CharacteristicOutcome {
    const characteristic = this.#requireCharacteristic(report.characteristic);
    const spec = SPECS[characteristic];
    const reported = parseReported(characteristic, report.value);
    const hisWord = this.#hisWordOn(characteristic);

    const agrees = hisWord === null ? null : spec.same(hisWord.value, reported);
    const using: Authority = hisWord === null ? REPORTED_BY : HIS_OWN_WORDS;
    const value = hisWord === null ? reported : hisWord.value;

    const thought = this.#thought(characteristic, reported, hisWord, agrees);
    const because = this.#because(characteristic, report, hisWord, agrees);

    const him = hisWord === null ? null : this.#graph.getNode(hisWord.nodeId);
    // NOT wrapped in a try. `review.ts` swallows a `RememberError` because one
    // conclusion of a night's several is worth losing to keep the rest; there is
    // nothing to keep here. The thought and the reason are both built above from
    // validated values, so neither can be blank — which means a refusal is a
    // real failure and the caller is told rather than handed a silent success.
    const remembered = this.#hers.remember({
      thought,
      because,
      // Resolved by label, never minted. When she has no person node for him
      // the memory simply has no edges — which is why the reporter is named in
      // the thought itself rather than only in the reasoning.
      ...(him === null ? {} : { about: [him.label] }),
    });

    const contradicts =
      agrees === false && hisWord !== null
        ? this.#contradict(remembered.nodeId, hisWord.nodeId, characteristic, reported, hisWord.value)
        : null;

    return {
      characteristic,
      reported: spec.render(reported),
      using,
      value,
      hisWord,
      agrees,
      why: this.#why(characteristic, reported, hisWord, agrees),
      nodeId: remembered.nodeId,
      created: remembered.created,
      contradicts,
      unknown: remembered.unknown,
    };
  }

  /**
   * The name, or a refusal that says which of the two lists it belongs to.
   *
   * A measurement type arriving here is worth its own message. It is the mistake
   * this whole phase is about, and *"unknown characteristic"* would send whoever
   * made it looking for a typo.
   */
  #requireCharacteristic(name: string): HealthCharacteristic {
    if (isHealthCharacteristic(name)) return name;
    if (isHealthType(name)) {
      throw new CharacteristicError(
        "is_a_measurement",
        "characteristic",
        `${JSON.stringify(name)} is a measurement, not a characteristic. It has a series, a ` +
          `watermark and a baseline, and it belongs in POST /health/samples. The three ` +
          `characteristics are ${HEALTH_CHARACTERISTICS.join(", ")}.`,
      );
    }
    throw new CharacteristicError(
      "not_a_characteristic",
      "characteristic",
      `${JSON.stringify(name)} is neither a characteristic (${HEALTH_CHARACTERISTICS.join(", ")}) ` +
        `nor a measurement (${HEALTH_TYPES.join(", ")}).`,
    );
  }

  /**
   * What he said, read from text that is about HIM and nobody else.
   *
   * His own person node first, then the `fact` nodes joined to it. Declining is
   * cheap and correct: `findCommanderNode` returns `null` when the graph cannot
   * say which node is his, and a wrong node here would read his wife's birthday
   * as his.
   */
  #hisWordOn(characteristic: HealthCharacteristic): HisWord | null {
    const him = findCommanderNode(this.#graph.listNodes({ kind: "person", limit: PERSON_SCAN_LIMIT }));
    if (him === null) return null;

    const own = hisWordIn(characteristic, textOf(him.label, him.body));
    if (own !== null) return { nodeId: him.id, value: own };

    for (const edge of this.#graph.edgesTouching(him.id)) {
      const otherId = edge.sourceNode === him.id ? edge.targetNode : edge.sourceNode;
      const node = this.#graph.getNode(otherId);
      if (node === null || node.kind !== "fact") continue;
      const said = hisWordIn(characteristic, textOf(node.label, node.body));
      if (said !== null) return { nodeId: node.id, value: said };
    }
    return null;
  }

  /**
   * The disagreement, as an edge nobody has to read prose to find.
   *
   * `findEdge` first, exactly as `extract-apply.ts` and `remember.ts` do: a
   * duplicate edge is refused by the store and would take the write down with
   * it, and a phone that re-uploads its characteristics is the ordinary case.
   */
  #contradict(
    memoryNode: string,
    hisNode: string,
    characteristic: HealthCharacteristic,
    reported: string,
    his: string,
  ): string {
    const already = this.#graph.findEdge(memoryNode, hisNode, CONTRADICTS_RELATION);
    if (already !== null) return already.id;

    const spec = SPECS[characteristic];
    const at = this.#clock();
    return this.#graph.infer({
      sourceNode: memoryNode,
      targetNode: hisNode,
      relation: CONTRADICTS_RELATION,
      reasoning:
        `${REPORTED_BY} reports his ${spec.noun} as ${spec.render(reported)}; this says ` +
        `${spec.render(his)}. She uses ${HIS_OWN_WORDS} — what he told her outranks what a ` +
        `device reported about him — and keeps the reading rather than dropping it.`,
      confidence: CONTRADICTION_CONFIDENCE,
      weight: CONTRADICTION_WEIGHT,
      demoteAfter: crossingInstant(CONTRADICTION_WEIGHT, at),
    }).id;
  }

  /** The memory's own text. The reporter is named in it, always. */
  #thought(
    characteristic: HealthCharacteristic,
    reported: string,
    hisWord: HisWord | null,
    agrees: boolean | null,
  ): string {
    const spec = SPECS[characteristic];
    const head = `${REPORTED_BY} reports his ${spec.noun} as ${spec.render(reported)}`;

    if (hisWord === null) {
      return (
        `${head}. He has not told her himself, so this is what she uses — a device's report ` +
        `about him, not something he said.`
      );
    }
    if (agrees === true) {
      return `${head}, which is what he told her. She uses ${HIS_OWN_WORDS}, and the reading agrees.`;
    }
    return (
      `${head}. He told her ${spec.render(hisWord.value)}, and ${HIS_OWN_WORDS} outrank a ` +
      `device's reading, so that is the one she uses.`
    );
  }

  /** Her reasoning, on the edge, where an inference's reasoning already lives. */
  #because(
    characteristic: HealthCharacteristic,
    report: CharacteristicReport,
    hisWord: HisWord | null,
    agrees: boolean | null,
  ): string {
    const spec = SPECS[characteristic];
    const provenance =
      `${REPORTED_BY} reported his ${spec.noun} on ${report.readAt} as a HealthKit ` +
      `characteristic — no series, no baseline, nothing measured.`;

    if (hisWord === null) {
      return `${provenance} She has no word of his on it, so she says where it came from whenever she uses it.`;
    }
    if (agrees === true) {
      return `${provenance} It agrees with what he told her, and his own words are what she uses either way.`;
    }
    return `${provenance} It disagrees with what he told her, and his own words win.`;
  }

  /** The sentence she can say when he asks which one she is using. */
  #why(
    characteristic: HealthCharacteristic,
    reported: string,
    hisWord: HisWord | null,
    agrees: boolean | null,
  ): string {
    const spec = SPECS[characteristic];
    if (hisWord === null) {
      return (
        `She has his ${spec.noun} as ${spec.render(reported)}, from ${REPORTED_BY}. He has not ` +
        `told her himself, so if that is wrong he only has to say so.`
      );
    }
    if (agrees === true) {
      return (
        `She has his ${spec.noun} as ${spec.render(hisWord.value)}, from ${HIS_OWN_WORDS}. ` +
        `${REPORTED_BY} says the same.`
      );
    }
    return (
      `She has his ${spec.noun} as ${spec.render(hisWord.value)}, from ${HIS_OWN_WORDS}. ` +
      `${REPORTED_BY} says ${spec.render(reported)}; what he told her wins.`
    );
  }
}

function textOf(label: string, body: string | null): string {
  return body === null || body.trim() === "" ? label : `${label}\n${body}`;
}
