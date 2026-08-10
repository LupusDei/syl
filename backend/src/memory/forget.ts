import { createHash } from "node:crypto";

import { instant, systemClock, type Clock } from "../services/clock.js";
import { newId } from "../services/id.js";
import type { Database } from "../services/sqlite.js";
import type { MemoryGraph } from "./graph.js";

/**
 * Explicit deletion: when the Commander says delete this memory, it is deleted.
 * `syl-eg3`, `syl-010.3.1`, `syl-010.3.2`.
 *
 * `0018_memory_deletions.sql` carries the argument for the mechanism. This
 * module is the only code that uses it, and four of its decisions are the ones
 * worth reading before changing anything.
 *
 *
 * ## 1. The hard part is not the delete. It is the RESIDUE
 *
 * Deleting the row is one statement. What makes this bead exist is everything
 * that is *about* the row and is not the row:
 *
 * | residue | where it lives | what happens to it |
 * | --- | --- | --- |
 * | the node's own text | `memory_nodes.label` / `.body` | deleted |
 * | the keyword index | `memory_nodes_fts` | deleted, by `0016`'s trigger |
 * | the embedding — a lossy copy of the text | `memory_vectors` | deleted |
 * | edges touching it | `memory_edges` | deleted, both species |
 * | **an inference's reasoning, which QUOTES what it reasoned over** | `memory_edges.reasoning` | deleted with the edge, or **redacted** where the edge survives |
 * | **the closed ledger rows — "what did I believe in March?"** | `memory_assertions` | deleted, whole chain |
 * | his verdict on the memory, in his words | `memory_feedback.note` | deleted |
 * | the projection prepended to every turn | `working_memory` | discarded; it regenerates |
 * | the night's prose about it | `dream_edge_reasoning`, `dream_surfaced`, `dream_duplicate_edges` | **redacted**, the rows kept (constraint 7) |
 *
 * The two rows in bold are the ones the bead says are most often missed, and
 * they are missed for opposite reasons. The reasoning text is missed because it
 * is not obviously part of the thing — it is a sentence on a different row, and
 * that sentence can name the thing outright. The ledger is missed because it is
 * *designed* to survive: `0015` refuses every DELETE, precisely so that "what
 * did I believe in March" stays answerable. Leave it alone and a forget leaves
 * a perfect record of the forgotten thing, closed rows and all.
 *
 *
 * ## 2. Deletion is NOT recursive, and the plan says so out loud
 *
 * Deleting a node's edges can leave the node at the far end with no edges. The
 * obvious next step — delete that one too — is refused.
 *
 * **The cascade goes exactly one hop: the nodes he named, and every edge
 * incident to any of them. It never crosses into a second node.** An edge
 * cannot survive its endpoint (`source_node REFERENCES memory_nodes`, and an
 * edge with one end missing is a broken row, not a memory); an observed edge
 * cannot survive its asserter either, because "asserted by a source" is what
 * makes an edge observed. Both of those are the row being *unrepresentable*
 * rather than a choice. A neighbouring NODE is not unrepresentable — it is a
 * memory in its own right that he did not name.
 *
 * The defence is that an unbounded cascade on a graph is its own kind of data
 * loss, and a worse kind: in a well-connected graph "forget this one thing"
 * would take out most of the graph, by a rule he cannot predict from what he
 * said. So orphans are **named in the plan** ({@link DeletionPlan.orphaned}) and
 * left alone. If he wants them, he names them, and gets a second plan he can
 * look at. Naming without deleting is the honest middle: it is neither a silent
 * cascade nor a silent hole.
 *
 * The recursion question is therefore answered by moving it out of the graph
 * and into the caller: {@link DeletionTarget.nodes} is an explicit list, not a
 * traversal. A caller that legitimately owns derived handles — an intake source
 * and the extract nodes that are nothing but its content — names them all, and
 * that naming is reviewable because it is data.
 *
 *
 * ## 3. Redaction, not deletion, for prose the delete did not name
 *
 * A surviving inference whose reasoning quotes the forgotten thing is not
 * itself about the forgotten thing. `Sadie is there because the acquisition is
 * on the agenda` connects two nodes that both survive. Deleting that edge would
 * destroy a memory he did not ask to forget; leaving it leaves a sentence about
 * the thing he did. So the edge stands and **its prose is replaced by a
 * tombstone naming the deletion record**, which is legible, auditable, and
 * quotes nothing.
 *
 * Machine-written prose is redacted automatically. **His own words are not.** A
 * surviving node's `label` or `body` that mentions the forgotten thing is
 * reported as {@link DeletionPlan.residue} and never touched: those are his
 * words or a source's, and silently rewriting one memory as a side effect of
 * deleting another is exactly the quiet mutation this whole subsystem is built
 * against. He can name it in a second delete.
 *
 * Matching is deliberately crude — the node's id, its label when the label is
 * long enough to be a quotation ({@link MIN_QUOTABLE_LABEL}), and any phrase the
 * caller adds. Over-redaction costs a sentence of machine-written justification.
 * Under-redaction leaves the residue this bead exists to remove. The asymmetry
 * decides which way to err.
 *
 *
 * ## 4. Confirmation is a digest of the plan, not a boolean
 *
 * It is irreversible and it is his own data, so nothing happens without a
 * confirmation. A boolean would only prove that somebody said yes once.
 * {@link DeletionPlan.confirmation} is a digest of everything the plan names, so
 * {@link Forgetting.execute} can re-plan and refuse when the graph has moved
 * since he looked. "He confirmed" then means "he confirmed THIS" — which
 * matters here more than almost anywhere, because a night can add an inference
 * between the moment he is shown the list and the moment he approves it, and
 * that inference would otherwise be deleted without ever appearing on a screen.
 */

/** What went wrong, as a closed set a caller can branch on. */
export type ForgetErrorKind =
  | "empty_target"
  | "not_confirmed"
  | "stale_confirmation"
  | "unknown_node"
  | "vectors_unreachable";

/** Thrown when a deletion cannot be planned or carried out as asked. */
export class ForgetError extends Error {
  readonly kind: ForgetErrorKind;

  constructor(kind: ForgetErrorKind, message: string) {
    super(message);
    this.name = "ForgetError";
    this.kind = kind;
  }
}

/**
 * Shortest label treated as a quotation when hunting residue.
 *
 * A two-character label occurs inside ordinary words — `ab` is in `grabbed` —
 * and matching on it would redact the reasoning of half the graph. Four is the
 * point where a label starts being a name rather than a fragment. The node's
 * ID is always matched, at any length, because it cannot occur by accident.
 */
export const MIN_QUOTABLE_LABEL = 4;

/** Every redaction starts with this, so one is recognisable on sight. */
export const REDACTION_PREFIX = "redacted:";

/** The `vec0` table `memory/store.ts` owns. Named here so the delete can reach it. */
const VECTOR_TABLE = "memory_vectors";

/** What to forget. An explicit list — see §2: there is no traversal. */
export interface DeletionTarget {
  /** Exactly these nodes. Never their neighbours. */
  readonly nodes: readonly string[];
  /**
   * Extra strings to hunt in derived prose, beyond the nodes' ids and labels.
   *
   * For the case the labels cannot cover: he asks to forget a fact whose label
   * is a summary, and the reasoning quotes a name from its body instead.
   */
  readonly quotedPhrases?: readonly string[];
}

/** A `(subject, relation)` key of the ledger, and how much history it holds. */
export interface AssertionKey {
  readonly subject: string;
  readonly relation: string;
  /** Rows in the chain, open and closed. The closed ones are the point. */
  readonly rows: number;
}

/** A surviving node whose own words mention the target. Reported, never touched. */
export interface ResiduePointer {
  readonly nodeId: string;
  readonly field: "label" | "body";
}

/**
 * Exactly what a deletion would remove, computed without writing anything.
 *
 * This is the thing he is shown before he confirms, so it is complete on
 * purpose: the counts, the ids, what survives with a hole in it, and what is
 * left over that this delete will not reach.
 */
export interface DeletionPlan {
  /** Echoed so {@link Forgetting.execute} can re-plan from the same request. */
  readonly target: DeletionTarget;
  readonly nodes: readonly string[];
  /** Both species. Incident to a named node, or asserted by one. */
  readonly edges: readonly string[];
  /** Every row of every touched key — see {@link Forgetting.plan}. */
  readonly assertions: readonly string[];
  readonly assertionKeys: readonly AssertionKey[];
  /** Surviving inferences whose reasoning quotes the target. Redacted, not deleted. */
  readonly redactedEdges: readonly string[];
  /** Dream-log rows whose prose quotes it. Redacted; the rows stay (constraint 7). */
  readonly redactedLogRows: number;
  /** `memory_feedback` rows — his verdicts, and the notes he wrote with them. */
  readonly feedback: number;
  /** Embeddings that will go. A vector is a lossy copy of the text. */
  readonly vectors: number;
  /** Survivors that will be left with no edges at all. NAMED, never deleted — §2. */
  readonly orphaned: readonly string[];
  /** His own words, elsewhere, that mention this. Reported and left alone — §3. */
  readonly residue: readonly ResiduePointer[];
  /** Digest of this plan. What "he confirmed" is checked against — §4. */
  readonly confirmation: string;
  /** SHA-256 of the material removed. Verifies a candidate; never reveals one. */
  readonly digest: string;
}

/** The order itself: who, where he said it, and what he approved. */
export interface DeletionOrder {
  /** The one permitted authority. A CHECK in `0018` says so too. */
  readonly instructedBy: "commander";
  /** WHERE he said it — a message id. Never WHAT he said. */
  readonly instructionRef?: string;
  /** {@link DeletionPlan.confirmation}, as shown to him. */
  readonly confirmation: string;
  /** About the operation, not the memory. */
  readonly note?: string;
}

/** The audit row, read back. Shape and authority; never content. */
export interface DeletionRecord {
  readonly id: string;
  readonly instructedBy: string;
  readonly instructionRef: string | null;
  readonly confirmation: string;
  readonly digest: string;
  readonly nodes: number;
  readonly edges: number;
  readonly assertions: number;
  readonly redactions: number;
  readonly note: string | null;
  readonly requestedAt: string;
  /** `null` means the authority window is still open. Should never happen. */
  readonly executedAt: string | null;
}

/** One id a deletion removed. The detail of the audit, and the permission. */
export interface DeletionScopeEntry {
  readonly target: string;
  readonly kind: "node" | "edge" | "assertion";
}

interface EdgeRow {
  readonly id: string;
  readonly reasoning: string | null;
}

interface NodeTextRow {
  readonly id: string;
  readonly label: string;
  readonly body: string | null;
}

interface AssertionRow {
  readonly id: string;
  readonly subject: string;
  readonly relation: string;
  readonly value: string;
}

export interface ForgettingOptions {
  readonly db: Database;
  readonly graph: MemoryGraph;
  readonly clock?: Clock;
}

/** `syl:memory_deletion:<uuidv7>`. */
function newDeletionId(): string {
  return newId("memory_deletion");
}

function sha256(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update(" ");
  }
  return hash.digest("hex");
}

/** `?, ?, ?` for an `IN` list. */
function holes(count: number): string {
  return new Array(count).fill("?").join(", ");
}

export class Forgetting {
  readonly #db: Database;
  readonly #graph: MemoryGraph;
  readonly #clock: Clock;

  constructor(options: ForgettingOptions) {
    this.#db = options.db;
    this.#graph = options.graph;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Work out exactly what deleting these nodes would remove. Writes nothing.
   *
   * The ledger is taken **by whole key**, not by row, and that is the one
   * choice here that looks heavy-handed and is not. Removing one link from the
   * middle of a `(subject, relation)` chain leaves a history that *lies*: the
   * surviving rows' validity intervals still describe the gap, so the record
   * says "the belief ran from X straight to Z" when it ran X, Y, Z — and
   * repairing the intervals would be rewriting history, which `0015`'s
   * immutability trigger exists to forbid. The unit of meaning in a bi-temporal
   * ledger is the chain. So the chain goes, and every key is listed in
   * {@link DeletionPlan.assertionKeys} with its row count before he confirms,
   * so it is a decision he sees rather than a surprise.
   *
   * @throws {ForgetError} `empty_target`, `unknown_node`, `vectors_unreachable`.
   */
  plan(target: DeletionTarget): DeletionPlan {
    const nodes = [...new Set(target.nodes)].sort();
    if (nodes.length === 0) {
      throw new ForgetError(
        "empty_target",
        `A deletion must name at least one node. A delete that names nothing is a bug in ` +
          `whatever produced it, and reporting it as a success would be the silent-forgetting ` +
          `failure arriving from the other direction.`,
      );
    }

    // Through `MemoryGraph.getNode`, which is an IDENTITY LOOKUP and therefore
    // spans every tier. That is deliberate: a cold or suppressed node is still
    // a memory of his, and "forget this" must reach the ones already set aside
    // as readily as the live ones — otherwise the most dormant copy of the
    // thing he asked to forget is the one that survives.
    const nodeRows: NodeTextRow[] = [];
    const missing: string[] = [];
    for (const id of nodes) {
      const node = this.#graph.getNode(id);
      if (node === null) missing.push(id);
      else nodeRows.push({ id: node.id, label: node.label, body: node.body });
    }
    if (missing.length > 0) {
      throw new ForgetError(
        "unknown_node",
        `${missing.join(", ")} is not a node in the memory graph. A deletion is refused rather ` +
          `than reported as a success, because "it was already gone" and "it was never reached" ` +
          `look identical to the caller and only one of them is safe.`,
      );
    }

    const phrases = this.#phrases(nodeRows, target.quotedPhrases ?? []);

    // Edges: incident to a named node, or asserted by one. One hop — see §2.
    const edgeRows = this.#db
      .prepare(
        `SELECT id, reasoning FROM memory_edges ` +
          `WHERE source_node IN (${holes(nodes.length)}) OR target_node IN (${holes(nodes.length)}) ` +
          `OR asserted_by IN (${holes(nodes.length)}) ORDER BY id`,
      )
      .all(...nodes, ...nodes, ...nodes) as unknown as readonly EdgeRow[];
    const edges = edgeRows.map((row) => row.id);
    const edgeSet = new Set(edges);

    // The ledger, by whole key. See the doc comment.
    const keyRows = this.#db
      .prepare(
        `SELECT DISTINCT subject, relation FROM memory_assertions ` +
          `WHERE subject IN (${holes(nodes.length)}) OR value_node IN (${holes(nodes.length)}) ` +
          `OR asserted_by IN (${holes(nodes.length)}) ORDER BY subject, relation`,
      )
      .all(...nodes, ...nodes, ...nodes) as unknown as readonly {
      subject: string;
      relation: string;
    }[];

    const assertions: string[] = [];
    const assertionKeys: AssertionKey[] = [];
    const assertionValues: string[] = [];
    for (const key of keyRows) {
      const rows = this.#db
        .prepare(
          `SELECT id, subject, relation, value FROM memory_assertions ` +
            `WHERE subject = ? AND relation = ? ORDER BY recorded_at, id`,
        )
        .all(key.subject, key.relation) as unknown as readonly AssertionRow[];
      for (const row of rows) {
        assertions.push(row.id);
        assertionValues.push(row.value);
      }
      assertionKeys.push({ subject: key.subject, relation: key.relation, rows: rows.length });
    }

    // Prose that survives the delete and quotes what it removed — §3.
    const survivors = this.#db
      .prepare(
        `SELECT id, reasoning FROM memory_edges WHERE kind = 'inferred' AND reasoning IS NOT NULL`,
      )
      .all() as unknown as readonly EdgeRow[];
    const redactedEdges = survivors
      .filter((row) => !edgeSet.has(row.id) && matches(row.reasoning, phrases))
      .map((row) => row.id);

    const redactedLogRows = this.#logRedactions(edges, nodes, phrases).length;

    const feedback = this.#count(
      `SELECT count(*) AS n FROM memory_feedback WHERE node_id IN (${holes(nodes.length)})`,
      nodes,
    );

    // His own words elsewhere. Reported, never rewritten — §3.
    const nodeSet = new Set(nodes);
    const residue: ResiduePointer[] = [];
    for (const row of this.#db
      .prepare("SELECT id, label, body FROM memory_nodes")
      .all() as unknown as readonly NodeTextRow[]) {
      if (nodeSet.has(row.id)) continue;
      if (matches(row.label, phrases)) residue.push({ nodeId: row.id, field: "label" });
      if (matches(row.body, phrases)) residue.push({ nodeId: row.id, field: "body" });
    }

    const orphaned = this.#orphansAfter(nodes, edges);
    const vectors = this.#countVectors(nodes);

    const digest = sha256([
      ...nodeRows.map((row) => `${row.id}${row.label}${row.body ?? ""}`),
      ...edgeRows.map((row) => `${row.id}${row.reasoning ?? ""}`),
      ...assertionValues,
    ]);

    const confirmation = sha256([
      "syl:deletion-plan:1",
      nodes.join(","),
      edges.join(","),
      assertions.join(","),
      redactedEdges.join(","),
      String(redactedLogRows),
      String(feedback),
      String(vectors),
      orphaned.join(","),
      residue.map((entry) => `${entry.nodeId}:${entry.field}`).join(","),
      digest,
    ]);

    return {
      target: { nodes, ...(target.quotedPhrases ? { quotedPhrases: target.quotedPhrases } : {}) },
      nodes,
      edges,
      assertions,
      assertionKeys,
      redactedEdges,
      redactedLogRows,
      feedback,
      vectors,
      orphaned,
      residue,
      confirmation,
      digest,
    };
  }

  /**
   * Carry the order out. Irreversible, audited, and all of it or none of it.
   *
   * The plan is recomputed here and compared against the confirmation the
   * caller passed, so a graph that moved between "here is what will go" and
   * "yes, do it" produces a refusal rather than a delete he never saw the shape
   * of. See §4.
   *
   * Everything runs inside ONE transaction, opened by writing the audit record
   * with no `executed_at` — which is what makes the triggers in `0012` and
   * `0015` step aside for exactly these ids and no others — and closed by
   * stamping it. A half-applied deletion would be the worst possible outcome
   * here: content gone, ledger intact, and nothing saying so.
   *
   * @throws {ForgetError} `not_confirmed`, `stale_confirmation`, and everything
   * {@link Forgetting.plan} throws.
   */
  execute(plan: DeletionPlan, order: DeletionOrder): DeletionRecord {
    if (order.confirmation === "") {
      throw new ForgetError(
        "not_confirmed",
        `A deletion is irreversible and it is his own data, so it does not happen without a ` +
          `confirmation of the plan he was shown.`,
      );
    }

    const current = this.plan(plan.target);
    if (order.confirmation !== current.confirmation) {
      throw new ForgetError(
        order.confirmation === plan.confirmation ? "stale_confirmation" : "not_confirmed",
        order.confirmation === plan.confirmation
          ? `The graph has moved since this plan was shown, so the confirmation is stale and the ` +
            `deletion is refused. Re-plan and show him the new list: a night can draw an ` +
            `inference between the moment he sees what will go and the moment he approves it, ` +
            `and that inference must not be deleted without ever appearing on a screen.`
          : `That confirmation does not match the deletion it was given for. Nothing was ` +
            `deleted. "He confirmed" has to mean "he confirmed THIS".`,
      );
    }

    const id = newDeletionId();
    const at = instant(this.#clock());
    const nodes = current.nodes;
    const redactionText =
      `${REDACTION_PREFIX} this text quoted a memory the Commander ordered deleted (${id})`;

    this.#transaction(() => {
      // 1. Open the authority window. This IS the audit record — see 0020 §1.
      this.#db
        .prepare(
          `INSERT INTO memory_deletions (id, instructed_by, instruction_ref, confirmation, ` +
            `digest, nodes, edges, assertions, redactions, note, requested_at, executed_at) ` +
            `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          order.instructedBy,
          order.instructionRef ?? null,
          current.confirmation,
          current.digest,
          nodes.length,
          current.edges.length,
          current.assertions.length,
          current.redactedEdges.length + current.redactedLogRows,
          order.note ?? null,
          at,
        );

      const scope = this.#db.prepare(
        "INSERT INTO memory_deletion_scope (deletion_id, target, kind) VALUES (?, ?, ?)",
      );
      for (const nodeId of nodes) scope.run(id, nodeId, "node");
      for (const edgeId of current.edges) scope.run(id, edgeId, "edge");
      for (const assertionId of current.assertions) scope.run(id, assertionId, "assertion");

      // 2. Redact the prose that survives. Before the deletes, so the plan's
      //    ids still resolve if a statement wants to check itself.
      for (const edgeId of current.redactedEdges) {
        this.#db
          .prepare("UPDATE memory_edges SET reasoning = ?, updated_at = ? WHERE id = ?")
          .run(redactionText, at, edgeId);
      }
      this.#redactLog(current.edges, nodes, this.#phrasesFor(nodes, current), redactionText);

      // 3. The ledger, whole chains, closed rows included. This is the half most
      //    likely to be missed: it is designed to survive.
      this.#deleteIn("memory_assertions", "id", current.assertions);

      // 4. Everything else that references a node, so the node can go.
      this.#deleteIn("memory_feedback", "node_id", nodes);
      this.#deleteIn("memory_vector_reindex", "node_id", nodes);
      if (current.vectors > 0 || this.#vectorTableExists()) {
        this.#deleteIn(VECTOR_TABLE, "node_id", nodes);
      }
      this.#deleteIn("memory_edges", "id", current.edges);

      // 5. The nodes. `0016`'s AFTER DELETE trigger clears the keyword index.
      this.#deleteIn("memory_nodes", "id", nodes);

      // 6. The projection is prepended to EVERY turn and may name what just
      //    went. It is regenerated, never accumulated (`0017`), so discarding
      //    it costs one rebuild and leaving it would put the forgotten thing
      //    into the next prompt.
      this.#db.prepare("DELETE FROM working_memory").run();

      // 7. Close the window. From here the exception reaches nothing.
      this.#db.prepare("UPDATE memory_deletions SET executed_at = ? WHERE id = ?").run(at, id);
    });

    return this.#recordOrThrow(id);
  }

  /** One audit record, or `null`. */
  record(id: string): DeletionRecord | null {
    const row = this.#db
      .prepare(
        `SELECT id, instructed_by, instruction_ref, confirmation, digest, nodes, edges, ` +
          `assertions, redactions, note, requested_at, executed_at FROM memory_deletions ` +
          `WHERE id = ?`,
      )
      .get(id);
    return row === undefined ? null : toRecord(row as unknown as RecordRow);
  }

  /** Every deletion, most recent first. The answer to "what has been removed?". */
  records(limit = 50): DeletionRecord[] {
    return this.#db
      .prepare(
        `SELECT id, instructed_by, instruction_ref, confirmation, digest, nodes, edges, ` +
          `assertions, redactions, note, requested_at, executed_at FROM memory_deletions ` +
          `ORDER BY requested_at DESC, id DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => toRecord(row as unknown as RecordRow));
  }

  /** Exactly which ids one deletion removed. */
  scopeOf(deletionId: string): DeletionScopeEntry[] {
    return this.#db
      .prepare(
        "SELECT target, kind FROM memory_deletion_scope WHERE deletion_id = ? ORDER BY kind, target",
      )
      .all(deletionId)
      .map((row) => row as unknown as DeletionScopeEntry);
  }

  /**
   * Deletions whose authority window is still open.
   *
   * Always empty in a consistent database — {@link Forgetting.execute} opens and
   * closes one inside a single transaction. It is exposed because an open window
   * is a standing permission to delete named rows, and a standing permission
   * nobody can see is exactly the shape of failure this subsystem exists to
   * refuse. A non-empty answer here is an alarm, not a status.
   */
  pending(): DeletionRecord[] {
    return this.#db
      .prepare(
        `SELECT id, instructed_by, instruction_ref, confirmation, digest, nodes, edges, ` +
          `assertions, redactions, note, requested_at, executed_at FROM memory_deletions ` +
          `WHERE executed_at IS NULL ORDER BY requested_at, id`,
      )
      .all()
      .map((row) => toRecord(row as unknown as RecordRow));
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Ids and labels worth hunting for in prose, plus whatever the caller added. */
  #phrases(rows: readonly NodeTextRow[], extra: readonly string[]): readonly string[] {
    const found = new Set<string>();
    for (const row of rows) {
      found.add(row.id.toLowerCase());
      const label = row.label.trim();
      if (label.length >= MIN_QUOTABLE_LABEL) found.add(label.toLowerCase());
    }
    for (const phrase of extra) {
      const trimmed = phrase.trim();
      if (trimmed.length >= MIN_QUOTABLE_LABEL) found.add(trimmed.toLowerCase());
    }
    return [...found];
  }

  /** The same phrases, during execution, when the rows are still readable. */
  #phrasesFor(nodes: readonly string[], plan: DeletionPlan): readonly string[] {
    const rows = this.#db
      .prepare(`SELECT id, label, body FROM memory_nodes WHERE id IN (${holes(nodes.length)})`)
      .all(...nodes) as unknown as readonly NodeTextRow[];
    return this.#phrases(rows, plan.target.quotedPhrases ?? []);
  }

  /**
   * Dream-log rows whose prose is about the deleted material.
   *
   * Constraint 7 says every dream session is logged permanently, and it means
   * it: the ROW stays, with its disposition, its pair, its tier transition and
   * its timing, so the telemetry about how the graph got here is not falsified
   * by a deletion. What goes is the free prose, which is a verbatim copy of the
   * same sentence the edge carried. The two constraints do not actually
   * collide: constraint 7 defends the existence of the log, and the Commander's
   * order is about the content — wherever it lives.
   */
  #logRedactions(
    edges: readonly string[],
    nodes: readonly string[],
    phrases: readonly string[],
  ): readonly { table: string; id: number; column: string }[] {
    const edgeSet = new Set(edges);
    const nodeSet = new Set(nodes);
    const hits: { table: string; id: number; column: string }[] = [];

    const reasoning = this.#db
      .prepare(
        "SELECT id, edge_id, source_node, target_node, reasoning FROM dream_edge_reasoning",
      )
      .all() as unknown as readonly {
      id: number;
      edge_id: string | null;
      source_node: string;
      target_node: string;
      reasoning: string;
    }[];
    for (const row of reasoning) {
      const named =
        (row.edge_id !== null && edgeSet.has(row.edge_id)) ||
        nodeSet.has(row.source_node) ||
        nodeSet.has(row.target_node);
      if (named || matches(row.reasoning, phrases)) {
        hits.push({ table: "dream_edge_reasoning", id: row.id, column: "reasoning" });
      }
    }

    const surfaced = this.#db.prepare("SELECT id, edge_id, summary FROM dream_surfaced").all() as
      unknown as readonly { id: number; edge_id: string | null; summary: string }[];
    for (const row of surfaced) {
      if ((row.edge_id !== null && edgeSet.has(row.edge_id)) || matches(row.summary, phrases)) {
        hits.push({ table: "dream_surfaced", id: row.id, column: "summary" });
      }
    }

    const duplicates = this.#db
      .prepare(
        "SELECT id, source_node, target_node, existing_edge_id, inserted_edge_id, note " +
          "FROM dream_duplicate_edges WHERE note IS NOT NULL",
      )
      .all() as unknown as readonly {
      id: number;
      source_node: string;
      target_node: string;
      existing_edge_id: string;
      inserted_edge_id: string | null;
      note: string;
    }[];
    for (const row of duplicates) {
      const named =
        nodeSet.has(row.source_node) ||
        nodeSet.has(row.target_node) ||
        edgeSet.has(row.existing_edge_id) ||
        (row.inserted_edge_id !== null && edgeSet.has(row.inserted_edge_id));
      if (named || matches(row.note, phrases)) {
        hits.push({ table: "dream_duplicate_edges", id: row.id, column: "note" });
      }
    }

    return hits;
  }

  #redactLog(
    edges: readonly string[],
    nodes: readonly string[],
    phrases: readonly string[],
    text: string,
  ): void {
    for (const hit of this.#logRedactions(edges, nodes, phrases)) {
      this.#db
        .prepare(`UPDATE ${hit.table} SET ${hit.column} = ? WHERE id = ?`)
        .run(text, hit.id);
    }
  }

  /** Survivors that lose their last edge. Named, never deleted — §2. */
  #orphansAfter(nodes: readonly string[], edges: readonly string[]): readonly string[] {
    if (edges.length === 0) return [];
    const going = new Set(nodes);
    const touched = new Set<string>();
    for (const row of this.#db
      .prepare(
        `SELECT source_node, target_node FROM memory_edges WHERE id IN (${holes(edges.length)})`,
      )
      .all(...edges) as unknown as readonly { source_node: string; target_node: string }[]) {
      if (!going.has(row.source_node)) touched.add(row.source_node);
      if (!going.has(row.target_node)) touched.add(row.target_node);
    }

    const doomed = new Set(edges);
    const orphans: string[] = [];
    for (const nodeId of [...touched].sort()) {
      const remaining = this.#db
        .prepare("SELECT id FROM memory_edges WHERE source_node = ? OR target_node = ?")
        .all(nodeId, nodeId) as unknown as readonly { id: string }[];
      if (remaining.every((row) => doomed.has(row.id))) orphans.push(nodeId);
    }
    return orphans;
  }

  /** Whether `memory_vectors` has been created on this database. */
  #vectorTableExists(): boolean {
    const row = this.#db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = ? LIMIT 1")
      .get(VECTOR_TABLE);
    return row !== undefined;
  }

  /**
   * How many embeddings would go.
   *
   * Zero when the vector table has never been created — a machine with no
   * `vec0` could never have written one, so there is nothing to reach and that
   * is a fact rather than a hope. But if the table IS registered and cannot be
   * read — the extension is not loaded into THIS connection — the deletion is
   * refused. An embedding is a lossy copy of the text; completing a forget
   * around one would leave the thing semantically searchable, which is the
   * residue failure wearing a different hat.
   *
   * @throws {ForgetError} `vectors_unreachable`.
   */
  #countVectors(nodes: readonly string[]): number {
    if (!this.#vectorTableExists()) return 0;
    try {
      return this.#count(
        `SELECT count(*) AS n FROM ${VECTOR_TABLE} WHERE node_id IN (${holes(nodes.length)})`,
        nodes,
      );
    } catch (cause) {
      throw new ForgetError(
        "vectors_unreachable",
        `${VECTOR_TABLE} exists on this database but cannot be read from this connection, so a ` +
          `deletion cannot reach the embeddings. An embedding is a lossy copy of the text: ` +
          `finishing a forget around one leaves the memory semantically searchable. Load the ` +
          `sqlite-vec extension (see memory/store.ts) and try again. Cause: ${describe(cause)}`,
      );
    }
  }

  #count(sql: string, bindings: readonly string[]): number {
    return (this.#db.prepare(sql).get(...bindings) as { n: number }).n;
  }

  #deleteIn(table: string, column: string, ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.#db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${holes(ids.length)})`).run(...ids);
  }

  #recordOrThrow(id: string): DeletionRecord {
    const record = this.record(id);
    if (record === null) {
      throw new ForgetError("not_confirmed", `Deletion record ${id} vanished during write.`);
    }
    return record;
  }

  /**
   * Run the whole deletion as one statement's worth of atomicity.
   *
   * `BEGIN IMMEDIATE` for the same reason `supersede.ts` uses it: the writes are
   * known up front, so taking the write lock at the start turns a lock upgrade
   * failure into a wait the busy timeout already handles.
   */
  #transaction(work: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.#db.exec("COMMIT");
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // The transaction was already gone. The original failure is the one
        // worth reporting, and swallowing this keeps it visible.
      }
      throw cause;
    }
  }
}

interface RecordRow {
  readonly id: string;
  readonly instructed_by: string;
  readonly instruction_ref: string | null;
  readonly confirmation: string;
  readonly digest: string;
  readonly nodes: number;
  readonly edges: number;
  readonly assertions: number;
  readonly redactions: number;
  readonly note: string | null;
  readonly requested_at: string;
  readonly executed_at: string | null;
}

function toRecord(row: RecordRow): DeletionRecord {
  return {
    id: row.id,
    instructedBy: row.instructed_by,
    instructionRef: row.instruction_ref,
    confirmation: row.confirmation,
    digest: row.digest,
    nodes: row.nodes,
    edges: row.edges,
    assertions: row.assertions,
    redactions: row.redactions,
    note: row.note,
    requestedAt: row.requested_at,
    executedAt: row.executed_at,
  };
}

/** Whether a haystack quotes anything the deletion is removing. Case-blind. */
function matches(haystack: string | null, phrases: readonly string[]): boolean {
  if (haystack === null || haystack === "") return false;
  const lower = haystack.toLowerCase();
  return phrases.some((phrase) => lower.includes(phrase));
}

function describe(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.endsWith(".") ? message : `${message}.`;
}
