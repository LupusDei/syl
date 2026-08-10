import { useMemo, type ReactElement } from "react";

import { token } from "../../theme/tokens";
import { toneColour } from "../../ui/Badge";
import {
  DEFAULT_LAYOUT_HEIGHT,
  DEFAULT_LAYOUT_WIDTH,
  edgeStyle,
  formatWeight,
  layoutNodes,
  type MemoryEdgeView,
  type MemoryNodeView,
  type WeightLawView,
} from "./memory-model";

/**
 * The graph, drawn.
 *
 * ## The one thing this picture must never do
 *
 * Let him confuse the two species. An observed edge was asserted by a source; an
 * inferred edge is Syl's speculation, and judging the inferred engine is the
 * reason this view exists. So the distinction is carried by the **shape** of the
 * stroke — solid against dashed — and only reinforced by colour, because colour
 * alone is invisible to a colour-blind reader and to a greyscale screenshot, and
 * this picture is going to end up in both.
 *
 * ## Weight is drawn, not printed
 *
 * Width and opacity both ride on the *decayed* weight, so the decay curve is
 * something he can see across the whole picture at once: near-floor edges are
 * thin ghosts, confirmed ones are solid ropes. A number in a table cannot do
 * that, which is the point of having a picture at all.
 *
 * ## Why there is no force simulation
 *
 * See `layoutNodes`. A force layout redraws the whole graph whenever anything
 * changes, so a reject would move the edge he is about to judge next out from
 * under his cursor. The layout here is deterministic and rank-ordered.
 *
 * ## Accessibility
 *
 * The SVG is a picture and says so. Every edge also appears as a row in the
 * table beneath it, where the reasoning is readable and the verdict buttons
 * live — so nothing here is the only route to any fact or any action.
 */

export interface GraphCanvasProps {
  readonly nodes: readonly MemoryNodeView[];
  readonly edges: readonly MemoryEdgeView[];
  readonly law: WeightLawView;
  readonly selectedEdgeId: string | null;
  readonly onSelectEdge: (edgeId: string | null) => void;
}

/** How big a node dot is. Fixed: node importance is position, not size. */
const NODE_RADIUS = 7;

export function GraphCanvas({
  nodes,
  edges,
  law,
  selectedEdgeId,
  onSelectEdge,
}: GraphCanvasProps): ReactElement {
  const positions = useMemo(() => layoutNodes(nodes, edges), [nodes, edges]);
  const labels = useMemo(
    () => new Map(nodes.map((node) => [node.id, node.label])),
    [nodes],
  );

  const inferred = edges.filter((edge) => edge.kind === "inferred").length;
  const observed = edges.length - inferred;

  return (
    <div className="graph">
      <svg
        className="graph__svg"
        viewBox={`0 0 ${String(DEFAULT_LAYOUT_WIDTH)} ${String(DEFAULT_LAYOUT_HEIGHT)}`}
        role="img"
        aria-label={
          `The hot region of Syl's memory graph: ${String(nodes.length)} nodes, ` +
          `${String(observed)} observed edges drawn solid and ${String(inferred)} inferred edges ` +
          `drawn dashed. Line thickness and opacity are the edge's decayed weight. ` +
          `Every edge is also a row in the table below.`
        }
      >
        <g>
          {edges.map((edge) => {
            const from = positions.get(edge.sourceNode);
            const to = positions.get(edge.targetNode);
            if (from === undefined || to === undefined) return null;
            const style = edgeStyle(edge, law);
            const selected = edge.id === selectedEdgeId;
            const colour = toneColour(style.tone);
            return (
              <g
                key={edge.id}
                data-testid={`edge-${edge.id}`}
                data-species={style.species}
                data-dash={style.dash ?? "solid"}
                className="graph__edge"
                onClick={() => {
                  onSelectEdge(selected ? null : edge.id);
                }}
              >
                <title>
                  {`${style.species}: ${labels.get(edge.sourceNode) ?? edge.sourceNode} — ` +
                    `${edge.relation} → ${labels.get(edge.targetNode) ?? edge.targetNode} ` +
                    `(weight ${formatWeight(edge.effectiveWeight)})`}
                </title>
                {/* A fat invisible line under the visible one: a 1px ghost edge
                    is impossible to hit with a mouse, and the near-floor edges
                    are exactly the ones worth clicking. */}
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="transparent"
                  strokeWidth={14}
                />
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={colour}
                  strokeWidth={selected ? style.strokeWidth + 2 : style.strokeWidth}
                  strokeOpacity={selected ? 1 : style.opacity}
                  {...(style.dash === null ? {} : { strokeDasharray: style.dash })}
                  strokeLinecap="round"
                />
              </g>
            );
          })}
        </g>

        <g>
          {nodes.map((node) => {
            const at = positions.get(node.id);
            if (at === undefined) return null;
            return (
              <g key={node.id} data-testid={`node-${node.id}`}>
                <circle
                  cx={at.x}
                  cy={at.y}
                  r={NODE_RADIUS}
                  fill={node.tier === "hot" ? token.accent : token.textMuted}
                  stroke={token.bgPanel}
                  strokeWidth={2}
                />
                <text
                  x={at.x}
                  y={at.y - NODE_RADIUS - 6}
                  textAnchor="middle"
                  fill={token.textSecondary}
                  fontSize={12}
                  fontFamily={token.fontUi}
                >
                  {node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <SpeciesLegend observed={observed} inferred={inferred} />
    </div>
  );
}

/**
 * The key, drawn with the same strokes as the picture.
 *
 * Words alone ("observed edges are solid") make the reader hold a mapping in
 * their head. Two actual line samples do not.
 */
export function SpeciesLegend({
  observed,
  inferred,
}: {
  readonly observed: number;
  readonly inferred: number;
}): ReactElement {
  return (
    <dl className="legend" data-testid="species-legend">
      <div className="legend__item">
        <dt>
          <svg width="52" height="12" aria-hidden="true">
            <line
              x1="2"
              y1="6"
              x2="50"
              y2="6"
              stroke={toneColour("accent")}
              strokeWidth={3}
              strokeLinecap="round"
            />
          </svg>
          Observed
        </dt>
        <dd>
          A source asserted it. {observed} here. Solid, and it carries provenance rather than
          reasoning — nobody guessed.
        </dd>
      </div>
      <div className="legend__item">
        <dt>
          <svg width="52" height="12" aria-hidden="true">
            <line
              x1="2"
              y1="6"
              x2="50"
              y2="6"
              stroke={toneColour("pending")}
              strokeWidth={3}
              strokeDasharray="6 4"
              strokeLinecap="round"
            />
          </svg>
          Inferred
        </dt>
        <dd>
          Syl&rsquo;s own speculation. {inferred} here. Dashed, and every one of them carries the
          reasoning that produced it — this is the engine under judgement.
        </dd>
      </div>
      <div className="legend__item">
        <dt>Thickness and opacity</dt>
        <dd>
          The <strong>decayed</strong> weight, not the stored one. A thin ghost is an edge on its
          way below the relevance floor; nothing is ever deleted, only demoted.
        </dd>
      </div>
    </dl>
  );
}
