import type { ReactElement } from "react";

import { formatDuration, formatInstant } from "../../format/time";
import { Badge } from "../../ui/Badge";
import { RateCell } from "./MetricsPanel";
import {
  coldSampleStateOf,
  formatWeight,
  type ColdSampleEdge,
  type ColdShapeView,
  type ReactivationReportView,
} from "./memory-model";

/**
 * What is down there, and can he still get at it?
 *
 * ## The Commander raised this himself
 *
 * *An edge drops below the floor and is now outside the partition key, so it
 * might never again be accessible.* He also overruled the prune recommendation
 * and chose demote-never-prune, and asked to be told plainly if that turns out
 * to have bought nothing. Both questions are answered here, and they are
 * answered by two different kinds of evidence:
 *
 * - **the numbers** — how big the dormant set is, how old, how fast it grows,
 *   and how often the sweep rediscovers something. These say whether the
 *   *machinery* works.
 * - **the handful** — a random sample of cold edges with the reasoning that
 *   justified each one. He asked for this by name: *"metrics tell us whether
 *   the machinery works; only he can tell us whether anything valuable is down
 *   there."* No aggregate will ever reveal a relevance floor set too
 *   aggressively. Only reading five of them will.
 *
 * The reasoning is therefore the widest column and is never truncated. It is
 * the only part of a cold edge he can actually have an opinion about.
 *
 * ## An empty sample is not "nothing is down there"
 *
 * Early on there are no cold edges because nothing has decayed yet, and that
 * renders as the same blank panel as a store that has been swept clean.
 * `coldSampleStateOf` separates them and this panel prints which one it is.
 *
 * ## `timeInCold` is null, not zero
 *
 * When nothing is cold there is no distribution to describe — which is a
 * different statement from "everything has been down there for no time". It is
 * rendered as a sentence, like every other absent measure on this page.
 */

export interface ColdStorePanelProps {
  readonly shape: ColdShapeView;
  readonly sample: readonly ColdSampleEdge[];
  readonly resurrection: ReactivationReportView;
}

export function ColdStorePanel({ shape, sample, resurrection }: ColdStorePanelProps): ReactElement {
  const state = coldSampleStateOf(shape, sample);

  return (
    <section className="panel" data-testid="cold-store-panel">
      <h2 className="panel__title">The cold store — what was set aside</h2>
      <p className="view__lede">
        Nothing here was deleted. An edge below the relevance floor leaves the scan and stays
        addressable, so if it ever becomes relevant again it can be promoted straight back. This
        panel is the evidence that the promise holds — and the handful you are meant to read.
      </p>

      <table className="table table--dense">
        <caption className="table__caption">The shape of it</caption>
        <tbody>
          <tr className="row">
            <th scope="row">Dormant edges</th>
            <td className="mono">{shape.edges}</td>
            <td className="table__prose">
              {shape.inferred} inferred, {shape.observed} observed. Reachable by identity — never by
              a scan.
            </td>
          </tr>
          <tr className="row">
            <th scope="row">Time down there</th>
            {shape.timeInCold === null ? (
              // Not "0ms". There is no distribution, which is a different fact
              // from a distribution of zeros.
              <td className="table__prose" data-testid="time-in-cold" data-known="false">
                <span className="rate rate--undefined">no distribution</span>
                <span className="row__sub">
                  nothing is cold, so there is no time-in-cold to describe — this is not a duration
                  of zero
                </span>
              </td>
            ) : (
              <td className="mono" data-testid="time-in-cold" data-known="true">
                p50 {formatDuration(shape.timeInCold.p50Ms)}
                <span className="row__sub mono">
                  p90 {formatDuration(shape.timeInCold.p90Ms)} · max{" "}
                  {formatDuration(shape.timeInCold.maxMs)}
                </span>
              </td>
            )}
            <td className="table__prose">
              Measured from <code>{shape.enteredBasis}</code>
              {shape.oldestEnteredAt !== null && ` · oldest entered ${formatInstant(shape.oldestEnteredAt)}`}
              .
            </td>
          </tr>
          <tr className="row">
            <th scope="row">Crossings per night</th>
            <RateCell
              rate={shape.crossingRatePerNight}
              testId="cold-crossing-rate"
              unit=""
              digits={2}
            />
            <td className="table__prose">
              How fast the dormant set is growing. Monotonic growth with nothing ever coming back is
              the empirical answer to whether never-prune bought anything.
            </td>
          </tr>
          <tr className="row">
            <th scope="row">Rediscoveries</th>
            <RateCell rate={resurrection.rate} testId="cold-resurrection-rate" unit="" digits={2} />
            <td className="table__prose">{resurrection.verdict.headline}</td>
          </tr>
        </tbody>
      </table>

      <h3 className="panel__subtitle">A handful to eyeball</h3>
      <p className="view__note">
        A random sample of dormant <em>inferences</em>, with the reasoning that justified each one.
        Inferences only: an observation carries no reasoning, and reasoning is what is being judged.
        The numbers above say whether the machinery works — only you can say whether any of this was
        worth keeping.
      </p>

      {state.reason !== "has_sample" ? (
        <div className="notice" data-testid="cold-sample-empty" data-reason={state.reason}>
          <div className="notice__head">
            <strong>{state.headline}</strong>
          </div>
          <p className="notice__body">{state.body}</p>
        </div>
      ) : (
        <table className="table table--dense">
          <caption className="table__caption">
            {sample.length} dormant inference(s), drawn at random
          </caption>
          <thead>
            <tr>
              <th scope="col">Connection</th>
              <th scope="col">Weight</th>
              <th scope="col">Dormant for</th>
              <th scope="col">Why Syl thought so</th>
            </tr>
          </thead>
          <tbody>
            {sample.map((edge) => (
              <tr className="row" key={edge.id} data-testid={`cold-sample-${edge.id}`}>
                <th scope="row" className="table__prose">
                  {edge.sourceLabel}
                  <span className="row__sub mono">
                    {edge.relation} → {edge.targetLabel}
                  </span>
                </th>
                <td className="mono">
                  {formatWeight(edge.weight)}
                  {edge.confidence !== null && (
                    <span className="row__sub mono">confidence {formatWeight(edge.confidence)}</span>
                  )}
                </td>
                <td className="mono">
                  {formatDuration(edge.ageMs)}
                  <span className="row__sub mono">since {formatInstant(edge.enteredColdAt)}</span>
                </td>
                {/* Never truncated. This is the only part of a cold edge he can
                    have an opinion about. */}
                <td className="table__prose">{edge.reasoning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="panel__subtitle">What came back, and why</h3>
      {resurrection.triggers.length === 0 ? (
        <p className="feedback feedback--empty" data-testid="no-resurrections">
          Nothing has been rediscovered yet. {resurrection.verdict.headline}
        </p>
      ) : (
        <table className="table table--dense">
          <caption className="table__caption">
            Cold-to-hot promotions. Each one would have been gone under a prune.
          </caption>
          <thead>
            <tr>
              <th scope="col">Night</th>
              <th scope="col">Confidence</th>
              <th scope="col">What brought it back</th>
            </tr>
          </thead>
          <tbody>
            {resurrection.triggers.map((trigger) => (
              <tr className="row" key={`${trigger.edgeId}-${trigger.at}`}>
                <th scope="row" className="mono">
                  {trigger.night}
                  <span className="row__sub">
                    <Badge tone="ok">reactivated</Badge>
                  </span>
                </th>
                <td className="mono">
                  {trigger.confidence === null ? "—" : formatWeight(trigger.confidence)}
                </td>
                <td className="table__prose">{trigger.reasoning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
