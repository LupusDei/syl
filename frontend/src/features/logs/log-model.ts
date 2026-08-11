/**
 * What the logs viewer decides, as pure functions.
 *
 * The view is a table over `LogEntry`, so almost none of it needs a DOM. What
 * does need testing is the judgement: which events matter, what a `turn.tool`
 * line actually says, and how a bag of unmodelled fields becomes one readable
 * column without hiding anything.
 *
 * **`turn.tool` is the reason this surface exists.** Syl runs pre-authorised on
 * the Commander's machine; that line is the record of what she did with the
 * permission. Everything here treats it as the primary row and the rest as
 * context around it.
 */

import type { LogEntry, LogLevel } from "@syl/shared/types";

import type { Tone } from "../../ui/Badge";

/**
 * Exhaustive by construction: a level added to the contract fails typecheck
 * here rather than dropping silently out of the filter — and the filter it
 * would drop out of is the one asking about the newest kind of failure.
 */
const LOG_LEVEL_SET: Record<LogLevel, true> = {
  debug: true,
  info: true,
  warn: true,
  error: true,
};

// Safe: the keys of an exhaustive `Record<LogLevel, …>` are exactly `LogLevel`.
export const LOG_LEVELS = Object.keys(LOG_LEVEL_SET) as readonly LogLevel[];

export function levelTone(level: LogLevel): Tone {
  switch (level) {
    case "error":
      return "fail";
    case "warn":
      return "warn";
    case "debug":
      return "muted";
    default:
      return "ok";
  }
}

/**
 * The event families worth a one-click filter, in the order they are offered.
 *
 * Prefixes, not names — the contract's `event` filter matches on a prefix, so
 * `turn` is the whole family and `turn.tool` is one member of it. "Tool calls"
 * comes first because it is the question this view was built to answer.
 */
export interface EventFilter {
  readonly label: string;
  /** The `event` query value. Empty means no filter. */
  readonly prefix: string;
  readonly summary: string;
}

export const EVENT_FILTERS: readonly EventFilter[] = [
  { label: "Everything", prefix: "", summary: "Every record in the log." },
  {
    label: "Tool calls",
    prefix: "turn.tool",
    summary: "What she actually did on the machine. One row per tool she reached for.",
  },
  {
    label: "Turns",
    prefix: "turn",
    summary: "Every turn from start to result, tool calls included.",
  },
  { label: "Conversation", prefix: "chat", summary: "What the conversation service said." },
  { label: "Jobs", prefix: "job", summary: "Scheduled work — what ran, and how late." },
  { label: "Service", prefix: "service", summary: "Starts, stops and startup notices." },
];

/** Is this the line that says what she did? */
export function isToolCall(entry: LogEntry): boolean {
  return entry.event === "turn.tool";
}

/**
 * The tool a `turn.tool` record names, or `null`.
 *
 * `null` rather than a placeholder: a tool call whose tool cannot be read is a
 * real anomaly — it means the logger wrote a shape nothing here expects — and
 * rendering it as "unknown tool" alongside the genuine ones would bury it.
 */
export function toolOf(entry: LogEntry): string | null {
  if (!isToolCall(entry)) return null;
  const tool = entry.fields["tool"];
  return typeof tool === "string" && tool.length > 0 ? tool : null;
}

/**
 * The one line a row shows for a record.
 *
 * Per-event, because the useful field differs and a generic dump makes every
 * row look the same. Anything unrecognised falls through to the generic
 * rendering rather than to an empty cell — a log viewer that shows nothing for
 * an event it has not been taught about is a log viewer that hides the new
 * thing, which is always the interesting thing.
 */
export function describeEntry(entry: LogEntry): string {
  const tool = toolOf(entry);
  if (tool !== null) return tool;

  const message = entry.fields["message"];
  if (typeof message === "string" && message.length > 0) return message;

  return formatFields(entry.fields);
}

/** `key=value` pairs, in insertion order, with values that are never `[object Object]`. */
export function formatFields(fields: Readonly<Record<string, unknown>>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${renderValue(value)}`)
    .join(" ");
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A circular structure cannot reach here through the wire — JSON got it to
    // us — but a caller could hand this function anything.
    return "(unserialisable)";
  }
}

/**
 * How many tool calls are in this page, and which tools.
 *
 * The summary line the Commander actually reads: "she called Bash 4 times and
 * Read twice today" is the answer to his question, and counting it here rather
 * than in the view means it can be asserted without a DOM.
 */
export interface ToolTally {
  readonly tool: string;
  readonly count: number;
}

export function tallyTools(entries: readonly LogEntry[]): readonly ToolTally[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const tool = toolOf(entry);
    if (tool === null) continue;
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => (b.count === a.count ? a.tool.localeCompare(b.tool) : b.count - a.count));
}

/**
 * The start of a local day, as the instant the API wants.
 *
 * "Today" is the Commander's day where he is standing, not UTC's — a query
 * built from `toISOString().slice(0, 10)` silently starts five hours late for
 * him, and the missing records are the early-morning ones, which is when the
 * agenda job runs.
 */
export function startOfLocalDay(now: Date): string {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}
