import type { ReactElement } from "react";

import { formatInstant } from "../../format/time";
import { Badge } from "../../ui/Badge";
import { ErrorNotice } from "../../ui/feedback";
import {
  describeTier,
  formatWeight,
  rankEdges,
  tierTone,
  type MemoryEdgeView,
  type MemoryNodeView,
} from "./memory-model";
import type { EdgeVerdict } from "./use-memory";

/**
 * Every edge, with its reasoning, and the two buttons that are the point.
 *
 * ## This table is the correction surface
 *
 * The picture above shows the shape of the graph. This is where the graph gets
 * *changed*. Seeing a wrong connection and killing it — or a good one and
 * confirming it — is the highest-value thing that happens on this page, and both
 * verdicts feed forces that already exist in the store:
 *
 * - **Reject** suppresses. The edge leaves every scan, its weight drops below
 *   the relevance floor in the same move, and reactivation can no longer address
 *   it. It is not deleted: constraint 6 says nothing is, and a suppressed edge
 *   stays visible here so the record of having said no is itself readable.
 * - **Confirm** is the engagement touch, and it is the *only* path an edge has
 *   to a weight above Syl's own internal traversal cap. Her retrieval can make
 *   an edge worth looking at; only he can make one certain. That asymmetry is a
 *   safety property — without it she reinforces her own beliefs with no contact
 *   with reality — so the button is labelled for what it does rather than as a
 *   generic thumbs-up.
 *
 * ## Reasoning is a column, not a tooltip
 *
 * "Show the edges with their weights AND THEIR REASONING." An inferred edge
 * whose justification is one hover away is an edge nobody judges. An observed
 * edge has no reasoning and gets its provenance instead — and the cell says
 * which of the two it is holding, so the columns cannot be read as one.
 */

export interface EdgeTableProps {
  readonly edges: readonly MemoryEdgeView[];
  readonly nodes: readonly MemoryNodeView[];
  readonly verdict: EdgeVerdict;
  readonly selectedEdgeId: string | null;
  readonly onSelectEdge: (edgeId: string | null) => void;
}

export function EdgeTable({
  edges,
  nodes,
  verdict,
  selectedEdgeId,
  onSelectEdge,
}: EdgeTableProps): ReactElement {
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  const ranked = rankEdges(edges);

  return (
    <>
      {verdict.error !== null && <ErrorNotice error={verdict.error} />}
      {verdict.last !== null && (
        <p className="view__note" data-testid="verdict-receipt">
          {verdict.last.verdict === "reject"
            ? "Rejected. The edge is suppressed: out of every scan, weight "
            : "Confirmed. The edge was lifted by your engagement: weight "}
          {formatWeight(verdict.last.weightBefore)} → {formatWeight(verdict.last.weightAfter)}.{" "}
          {verdict.last.surfacedRecorded > 0
            ? `${String(verdict.last.surfacedRecorded)} thing(s) she surfaced to you answered.`
            : "She had not surfaced this one to you, so no engagement row was answered."}
        </p>
      )}

      <table className="table table--dense">
        <caption className="table__caption">
          Edges — inferred first, heaviest first. This is where the graph gets corrected.
        </caption>
        <thead>
          <tr>
            <th scope="col">Species</th>
            <th scope="col">Connection</th>
            <th scope="col">Weight</th>
            <th scope="col">Tier</th>
            <th scope="col">Why, or who said so</th>
            <th scope="col">Verdict</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((edge) => (
            <EdgeRow
              key={edge.id}
              edge={edge}
              labels={labels}
              verdict={verdict}
              selected={edge.id === selectedEdgeId}
              onSelect={onSelectEdge}
            />
          ))}
        </tbody>
      </table>
    </>
  );
}

function EdgeRow({
  edge,
  labels,
  verdict,
  selected,
  onSelect,
}: {
  readonly edge: MemoryEdgeView;
  readonly labels: ReadonlyMap<string, string>;
  readonly verdict: EdgeVerdict;
  readonly selected: boolean;
  readonly onSelect: (edgeId: string | null) => void;
}): ReactElement {
  const inferred = edge.kind === "inferred";
  const busy = verdict.pendingEdgeId === edge.id;
  const failed = verdict.failedEdgeId === edge.id;
  const suppressed = edge.tier === "suppressed";

  return (
    <tr
      className={selected ? "row row--selected" : "row"}
      data-testid={`edge-row-${edge.id}`}
      data-species={edge.kind}
      onClick={() => {
        onSelect(selected ? null : edge.id);
      }}
    >
      <th scope="row">
        {/* The species chip and the dash sample together: the table and the
            picture must be readable as the same two things. */}
        <span className="species">
          <svg width="34" height="10" aria-hidden="true">
            <line
              x1="1"
              y1="5"
              x2="33"
              y2="5"
              stroke="currentColor"
              strokeWidth={2.5}
              {...(inferred ? { strokeDasharray: "5 3" } : {})}
            />
          </svg>
          <Badge tone={inferred ? "pending" : "accent"} title={edge.kind}>
            {inferred ? "inferred" : "observed"}
          </Badge>
        </span>
      </th>
      <td className="table__prose">
        {labels.get(edge.sourceNode) ?? edge.sourceNode}
        <span className="row__sub mono">
          {edge.relation} → {labels.get(edge.targetNode) ?? edge.targetNode}
        </span>
      </td>
      <td className="mono">
        {formatWeight(edge.effectiveWeight)}
        <span className="row__sub mono">
          stored {formatWeight(edge.storedWeight)}
          {edge.confidence !== null && ` · confidence ${formatWeight(edge.confidence)}`}
        </span>
      </td>
      <td>
        <Badge tone={tierTone(edge.tier)} title={describeTier(edge.tier)}>
          {edge.tier}
        </Badge>
        <span className="row__sub mono">
          {edge.demoteAfter === null ? "no crossing scheduled" : `crosses ${formatInstant(edge.demoteAfter)}`}
        </span>
      </td>
      <td className="table__prose">
        {/* Two different facts, never one column of "provenance". An
            inference's reasoning is a claim to be judged; an observation's
            asserter is a fact about where it came from. */}
        {inferred ? (
          edge.reasoning
        ) : (
          <em>
            Asserted by <span className="mono">{edge.assertedBy}</span>. An observation carries no
            reasoning — a source simply said so.
          </em>
        )}
      </td>
      <td>
        {suppressed ? (
          <span className="row__sub">
            You rejected this. Nothing brings it back implicitly.
          </span>
        ) : (
          <span className="verdict">
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void verdict.judge(edge.id, "confirm");
              }}
            >
              {busy ? "…" : "Confirm"}
            </button>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void verdict.judge(edge.id, "reject");
              }}
            >
              {busy ? "…" : "Reject"}
            </button>
          </span>
        )}
        {failed && (
          <span className="row__sub" data-testid={`verdict-failed-${edge.id}`}>
            That verdict did not land. Syl still believes this.
          </span>
        )}
      </td>
    </tr>
  );
}
