import type { MemoryGraph, MemoryNode } from "./graph.js";
import { isMemoryNodeKind, type MemoryNodeKind } from "./schema.js";

/**
 * The four-field projection contract.
 *
 * > **A row is the record. A node is the handle.** — Proposal B
 *
 * Every life-model row projects into the graph as a node carrying exactly
 * `{ id, type, label, ref }`. No status. No dates. No counts.
 *
 *
 * ## The failure this prevents, and why nothing catches it
 *
 * Duplicate a goal's `status` into the graph and there are now two sources of
 * truth for it. The Commander marks the goal `abandoned`; the `goals` row
 * changes; the node keeps asserting `active`. **Nothing errors.** No
 * constraint is violated, no query returns nothing, no log line appears. The
 * next dream reasons from a fact that stopped being true weeks ago and
 * produces an inference that is perfectly well-formed and simply wrong — and
 * that inference gets its own `reasoning` string, so it will look *justified*
 * to whoever reads it.
 *
 * The general rule: **the graph stores what does not change, and a handle to
 * the row that does.** A goal's identity, its name and the fact that it exists
 * are stable. Its status, its target date, how many to-dos are under it — all
 * of that moves, and all of it is one `JOIN` away through `ref`.
 *
 *
 * ## Why this is structural rather than a review rule
 *
 * "Don't copy mutable state into the graph" is a thing a reviewer has to
 * notice, on every future pull request, forever. It will be noticed most of
 * the time, which is the same as failing — the whole point of a memory system
 * is that it is right in a year.
 *
 * Four mechanisms, from cheapest to last-resort:
 *
 * 1. **{@link ProjectionHandle} has three fields** (the fourth, `id`, is
 *    minted by the graph). An object literal carrying `status` fails excess
 *    property checking on the spot.
 * 2. **{@link handle} rejects extra fields even from a variable.** Excess
 *    property checking only fires on literals, so `handle(someGoal)` would
 *    otherwise compile. The `NoExtra` constraint makes every key outside the
 *    contract `never`, so it is a compile error either way.
 * 3. **{@link asHandle} refuses them at runtime** — for a cast, a JSON
 *    round-trip, or anything arriving from outside TypeScript.
 * 4. **{@link projectInto} never passes `body`.** `CreateNodeInput` has a free
 *    text field, and free text is where a rule like this actually dies:
 *    `body: JSON.stringify(goal)` type-checks perfectly. The writer here is
 *    the only path that mints a handle and it has no way to reach that column.
 *
 *
 * ## Regeneration, and why it is idempotent
 *
 * A handle is looked up by `(ref, type)` — `subject_id` and `kind` in the
 * store — and `memory_nodes_handle_idx` in `0019_working_memory.sql` makes
 * that pair UNIQUE for the kinds a projector mints, so a second handle for one
 * row is a database error rather than a silent fork.
 *
 * Reconciling therefore does one of three things per row: create, relabel, or
 * nothing. {@link MemoryGraph.relabel} carries `AND label <> ?`, so "nothing"
 * really is nothing — not even an `updated_at` bump. Run
 * {@link reconcileProjections} twice over an unchanged life model and the
 * second pass reports `changed: false` and leaves every timestamp where it
 * was.
 */

/** The complete projection payload. Four fields, and there is no fifth. */
export interface NodeProjection {
  /** The node's own id, `syl:memory_node:<uuidv7>`. Minted by the graph. */
  readonly id: string;
  /** The node kind. Mirrors the life-model row's type. */
  readonly type: MemoryNodeKind;
  /** What to call it. The one field of the four that may legitimately move. */
  readonly label: string;
  /** The row this is a handle for — `syl:goal:<uuid>`, `syl:source:<uuid>`. */
  readonly ref: string;
}

/**
 * What a projector supplies: the contract minus the id the graph mints.
 *
 * Keep this to three fields. Every field added here is a second source of
 * truth for whatever it duplicates.
 */
export interface ProjectionHandle {
  readonly type: MemoryNodeKind;
  readonly label: string;
  readonly ref: string;
}

/** The four field names, so a test can assert on the contract itself. */
export const PROJECTION_FIELDS = ["id", "type", "label", "ref"] as const;

/** The three a projector supplies. */
export const HANDLE_FIELDS = ["type", "label", "ref"] as const;

/**
 * `T`, but every key outside `Shape` typed `never`.
 *
 * This is what closes the hole that excess property checking leaves open:
 * checking only fires on object literals, so a `Goal` in a variable — with its
 * `status`, `targetDate` and `updatedAt` — is assignable to a three-field
 * interface and the compiler is content. Constraining the PARAMETER this way
 * makes the extra keys unsatisfiable, so the call fails wherever the value
 * came from.
 */
export type NoExtra<T, Shape> = T & Record<Exclude<keyof T, keyof Shape>, never>;

/** What was wrong with a would-be projection. */
export type ProjectionErrorKind = "bad_ref" | "bad_type" | "blank_label" | "extra_field";

/** Thrown when something tries to project outside the contract. */
export class ProjectionError extends Error {
  readonly kind: ProjectionErrorKind;

  constructor(kind: ProjectionErrorKind, message: string) {
    super(message);
    this.name = "ProjectionError";
    this.kind = kind;
  }
}

/** `syl:<type>:<uuid>` — the shape `memory_nodes.subject_id` CHECKs for. */
const REF =
  /^syl:[a-z][a-z_]*:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Build a handle, refusing anything the contract does not carry.
 *
 * Every projector goes through this. The generic constraint is the point:
 * `handle(goal)` does not compile, and neither does
 * `handle({ ...fields, status })`, whether the extra field is on a literal or
 * on a value that has been through five function calls first.
 *
 * @throws {ProjectionError} `bad_type`, `blank_label`, `bad_ref`.
 */
export function handle<T extends ProjectionHandle>(
  input: NoExtra<T, ProjectionHandle>,
): ProjectionHandle {
  return asHandle(input);
}

/**
 * The same contract, checked at runtime.
 *
 * The compile-time half is defeated by a cast, by `JSON.parse`, and by
 * anything crossing a boundary TypeScript does not police. This is the half
 * that survives all three, and it is deliberately a REFUSAL rather than a
 * projection down to the four fields: silently dropping `status` would let a
 * caller believe it had been stored.
 *
 * @throws {ProjectionError} `extra_field`, `bad_type`, `blank_label`,
 * `bad_ref`.
 */
export function asHandle(value: unknown): ProjectionHandle {
  if (typeof value !== "object" || value === null) {
    throw new ProjectionError("extra_field", `A projection handle must be an object.`);
  }

  const extra = Object.keys(value).filter(
    (key) => !(HANDLE_FIELDS as readonly string[]).includes(key),
  );
  if (extra.length > 0) {
    throw new ProjectionError(
      "extra_field",
      `A projected node carries exactly { type, label, ref } and nothing else; this one also ` +
        `carries ${extra.join(", ")}. A row is the record and a node is the handle: mutable ` +
        `life-model state copied into the graph becomes a second source of truth that drifts ` +
        `without ever failing. Read it through ref instead.`,
    );
  }

  const candidate = value as Partial<ProjectionHandle>;
  if (!isMemoryNodeKind(candidate.type)) {
    throw new ProjectionError(
      "bad_type",
      `${String(candidate.type)} is not a memory node kind, so nothing can be projected as one.`,
    );
  }
  if (typeof candidate.label !== "string" || candidate.label.trim() === "") {
    throw new ProjectionError(
      "blank_label",
      `A handle's label cannot be blank — it is the only human-readable field of the four.`,
    );
  }
  if (typeof candidate.ref !== "string" || !REF.test(candidate.ref)) {
    throw new ProjectionError(
      "bad_ref",
      `A handle's ref must address a life-model row, like syl:goal:<uuid>, got ` +
        `${JSON.stringify(candidate.ref)}. A handle with no row behind it is not a handle.`,
    );
  }

  return { type: candidate.type, label: candidate.label.trim(), ref: candidate.ref };
}

/**
 * The projectors that exist today.
 *
 * Each is one line on purpose. A projector that needs logic is a projector
 * that is deciding what to copy, and the answer to that is always "the label,
 * and nothing else".
 */

/** A goal row's handle. `status`, `targetDate` and `why` stay in the row. */
export function projectGoal(row: { readonly id: string; readonly title: string }): ProjectionHandle {
  return handle({ type: "goal", label: row.title, ref: row.id });
}

/**
 * An ingested source's handle.
 *
 * `stage`, `retention`, `expiresAt`, `bytes` and `chunkCount` all move over a
 * source's life and none of them is here. The graph knows the source exists
 * and what it is called; `intake_sources` remains the authority on everything
 * about it, including how carefully it must be deleted.
 */
export function projectSource(row: {
  readonly id: string;
  readonly title: string | null;
  readonly canonicalUrl: string;
}): ProjectionHandle {
  return handle({ type: "source", label: row.title ?? row.canonicalUrl, ref: row.id });
}

/** What happened to one handle during a reconcile. */
export type ProjectionOutcome = "created" | "relabelled" | "unchanged";

/** One row's result. */
export interface ProjectedNode {
  readonly projection: NodeProjection;
  readonly outcome: ProjectionOutcome;
}

/** What a whole reconcile did. */
export interface ReconcileResult {
  readonly nodes: readonly ProjectedNode[];
  readonly created: number;
  readonly relabelled: number;
  readonly unchanged: number;
  /** `false` when the graph was already exactly this. */
  readonly changed: boolean;
}

/** A node reduced to the contract. Nothing else about the row escapes. */
export function toProjection(node: MemoryNode): NodeProjection {
  if (node.subjectId === null) {
    throw new ProjectionError(
      "bad_ref",
      `Node ${node.id} has no subject, so it is not a handle for anything. Only nodes projected ` +
        `from a life-model row carry the four-field contract.`,
    );
  }
  return { id: node.id, type: node.kind, label: node.label, ref: node.subjectId };
}

/**
 * Write one handle into the graph, creating or renaming as needed.
 *
 * The only path that mints a projected node. It passes `kind`, `label` and
 * `subjectId` to {@link MemoryGraph.addNode} and nothing else — in particular
 * never `body`, which is the free-text column where a rule like this would
 * otherwise be quietly worked around.
 *
 * @throws {ProjectionError} from {@link asHandle}.
 */
export function projectInto(graph: MemoryGraph, input: ProjectionHandle): ProjectedNode {
  const checked = asHandle(input);
  const existing = graph
    .nodesForSubject(checked.ref)
    .find((node) => node.kind === checked.type);

  if (existing === undefined) {
    const created = graph.addNode({
      kind: checked.type,
      label: checked.label,
      subjectId: checked.ref,
    });
    return { projection: toProjection(created), outcome: "created" };
  }

  if (existing.label === checked.label) {
    return { projection: toProjection(existing), outcome: "unchanged" };
  }

  const renamed = graph.relabel(existing, checked.label);
  return { projection: toProjection(renamed), outcome: "relabelled" };
}

/**
 * Bring the graph's handles into line with the life model.
 *
 * Idempotent by construction: every step is create-or-rename keyed on
 * `(ref, type)`, and renaming to the current name is a no-op down at the SQL.
 * Run it twice over an unchanged life model and the second run reports
 * `changed: false` with every `updatedAt` untouched — which is the acceptance
 * criterion for `syl-005.1.4`, and the property that distinguishes a
 * projection from a store.
 *
 * @throws {ProjectionError} on the first handle that breaks the contract. It
 * does not skip and continue: a projector that has started carrying mutable
 * state is a bug to fix, not a row to drop.
 */
export function reconcileProjections(
  graph: MemoryGraph,
  handles: readonly ProjectionHandle[],
): ReconcileResult {
  const nodes = handles.map((input) => projectInto(graph, input));
  const count = (outcome: ProjectionOutcome): number =>
    nodes.filter((node) => node.outcome === outcome).length;

  const created = count("created");
  const relabelled = count("relabelled");
  return {
    nodes,
    created,
    relabelled,
    unchanged: count("unchanged"),
    changed: created + relabelled > 0,
  };
}
