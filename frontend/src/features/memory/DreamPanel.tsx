import type { ReactElement } from "react";

import { formatCost } from "../../format/text";
import { formatInstant } from "../../format/time";
import { Badge, type Tone } from "../../ui/Badge";
import { Empty } from "../../ui/feedback";
import type { DreamNightView, MemoryNodeView } from "./memory-model";

/**
 * What the last nights of reflection produced, and what they set aside.
 *
 * ## Why every disposition is listed, including the rejections
 *
 * `syl-005.4.2` records a reasoning row for every disposition the dream takes —
 * created, reactivated, suppressed **and rejected** — and keeping the rejections
 * is what makes the astrology rate readable rather than merely countable. A
 * panel that showed only the edges that were created would flatter the engine by
 * construction: it would hide every candidate it proposed and then threw away,
 * which is exactly the ratio he is trying to judge.
 *
 * ## Supersession, kept beside it
 *
 * Nodes are superseded, edges are demoted, nothing is destroyed. So "what was
 * superseded" is a list of nodes that were moved out of the live partition, and
 * it belongs next to the night that moved them.
 */

export interface DreamPanelProps {
  readonly nights: readonly DreamNightView[];
  readonly superseded: readonly MemoryNodeView[];
  /** False when reflection has never executed at all. */
  readonly dreamHasEverRun: boolean;
  readonly windowNights: number;
}

export function DreamPanel({
  nights,
  superseded,
  dreamHasEverRun,
  windowNights,
}: DreamPanelProps): ReactElement {
  return (
    <section className="panel" data-testid="dream-panel">
      <h2 className="panel__title">The last {windowNights} night(s)</h2>

      {nights.length === 0 && (
        <Empty>
          {dreamHasEverRun
            ? `Reflection has run before, but not in the last ${String(windowNights)} night(s). ` +
              "Nothing is being hidden — the service returned no sessions for this window."
            : "No dream has ever run. There is nothing to report about reflection, and that is " +
              "the correct answer rather than a missing one — the nightly engine has not been " +
              "switched on yet."}
        </Empty>
      )}

      {nights.map((night) => (
        <article className="night" key={night.sessionId} data-testid={`night-${night.night}`}>
          <header className="night__head">
            <strong>{night.night}</strong>
            <Badge tone={night.outcome === "completed" ? "ok" : night.error === null ? "pending" : "fail"}>
              {night.outcome}
            </Badge>
            <span className="mono">
              {night.turns} turn(s) · {night.tokensSpent} token(s) · {formatCost(night.costUsd)}
            </span>
          </header>
          {night.error !== null && <p className="notice__body">{night.error}</p>}

          <p className="night__counts mono">
            proposed {night.counts.candidatesProposed} · judged {night.counts.candidatesJudged} ·
            created {night.counts.edgesCreated} · reactivated {night.counts.edgesReactivated} ·
            suppressed {night.counts.edgesSuppressed} · demoted {night.counts.edgesDemoted} ·
            nodes superseded {night.counts.nodesSuperseded}
          </p>

          {night.dispositions.length > 0 && (
            <table className="table table--dense">
              <caption className="table__caption">
                Every judgement this night made, rejections included
              </caption>
              <thead>
                <tr>
                  <th scope="col">Disposition</th>
                  <th scope="col">Moved</th>
                  <th scope="col">Reasoning</th>
                </tr>
              </thead>
              <tbody>
                {night.dispositions.map((row) => (
                  <tr key={row.id} className="row">
                    <th scope="row">
                      <Badge tone={dispositionTone(row.disposition)} title={row.disposition}>
                        {row.disposition}
                      </Badge>
                    </th>
                    <td className="mono">
                      {row.tierBefore ?? "—"} → {row.tierAfter ?? "—"}
                      {row.confidence !== null && (
                        <span className="row__sub mono">confidence {row.confidence.toFixed(2)}</span>
                      )}
                    </td>
                    <td className="table__prose">{row.reasoning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {night.surfaced.length > 0 && (
            <table className="table table--dense">
              <caption className="table__caption">What she chose to tell you</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Your answer</th>
                </tr>
              </thead>
              <tbody>
                {night.surfaced.map((row) => (
                  <tr key={row.id} className="row">
                    <th scope="row" className="mono">
                      {formatInstant(row.surfacedAt)}
                    </th>
                    <td className="table__prose">{row.summary}</td>
                    <td>
                      <Badge tone={row.response === "pending" ? "pending" : "muted"}>
                        {row.response}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      ))}

      <h3 className="panel__subtitle">Superseded</h3>
      {superseded.length === 0 ? (
        <Empty>
          Nothing has been superseded. Nodes are superseded, edges are demoted, and nothing is ever
          destroyed — so this list only grows.
        </Empty>
      ) : (
        <table className="table table--dense">
          <caption className="table__caption">
            Nodes set aside, most recently set aside first. Still addressable, never deleted.
          </caption>
          <thead>
            <tr>
              <th scope="col">Set aside</th>
              <th scope="col">Kind</th>
              <th scope="col">Label</th>
            </tr>
          </thead>
          <tbody>
            {superseded.map((node) => (
              <tr key={node.id} className="row">
                <th scope="row" className="mono">
                  {formatInstant(node.updatedAt)}
                </th>
                <td className="mono">{node.kind}</td>
                <td className="table__prose">{node.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * How a disposition reads.
 *
 * `rejected` is muted rather than red: a candidate the dream considered and
 * threw away is the engine working, not the engine failing. `suppressed` is red
 * because that one is the Commander's own no, applied by the dream.
 */
function dispositionTone(disposition: string): Tone {
  switch (disposition) {
    case "created":
      return "ok";
    case "reactivated":
      return "accent";
    case "suppressed":
      return "fail";
    case "rejected":
      return "muted";
    default:
      return "pending";
  }
}
