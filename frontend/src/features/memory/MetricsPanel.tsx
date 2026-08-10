import type { ReactElement } from "react";

import { formatCost } from "../../format/text";
import { describeRate, type MemoryMetricsView, type Rate, type WeightBucket } from "./memory-model";

/**
 * The instrument panel: is any of this working?
 *
 * ## The one rule this file exists to hold
 *
 * **A `null` rate is never rendered as `0%`, and never as a zeroed bar.**
 * `metrics.ts` makes every ratio `null` with a sentence when the denominator is
 * zero, precisely so a surface can say why instead of publishing a number that
 * means nothing. "0% of surfaced connections were rejected" is excellent news
 * out of a hundred and says nothing at all out of none, and the two render
 * identically unless something refuses to draw the second.
 *
 * So there is exactly one component for a ratio — {@link RateCell} — and it
 * branches before it formats. There is no path through this file that turns a
 * null into a percentage or into a bar of length zero.
 *
 * ## The histogram is the health of the engine
 *
 * Mass piled in the bottom bucket means the dream is manufacturing connections
 * that nothing ever confirms and quietly demoting them nightly. `bottomHeavy` is
 * the number, and it is a `Rate` like everything else — an empty store has no
 * shape, and an empty store is not a healthy one.
 */

export interface MetricsPanelProps {
  readonly metrics: MemoryMetricsView;
}

export function MetricsPanel({ metrics }: MetricsPanelProps): ReactElement {
  const { store, survival, reactivation, engagement, cost } = metrics;

  return (
    <section className="panel" data-testid="metrics-panel">
      <h2 className="panel__title">Is any of this working?</h2>
      <p className="view__lede">
        Every number here is computed from rows at read time — nothing is a counter, so nothing can
        drift, and a fixed query answers three months of history correctly.
      </p>

      <table className="table table--dense">
        <caption className="table__caption">The store</caption>
        <tbody>
          <tr className="row">
            <th scope="row">Nodes</th>
            <td className="mono">{store.nodes.total}</td>
            <td className="table__prose">Across every tier.</td>
          </tr>
          <tr className="row">
            <th scope="row">Edges</th>
            <td className="mono">{store.edges.total}</td>
            <td className="table__prose">
              {store.edges.observed} observed, {store.edges.inferred} inferred — {store.edges.active}{" "}
              live, {store.edges.dormant} dormant, {store.edges.suppressed} rejected by you.
            </td>
          </tr>
          <tr className="row">
            <th scope="row">Supersessions</th>
            <td className="mono">{store.supersessions}</td>
            <td className="table__prose">Nodes set aside. Nothing destroyed.</td>
          </tr>
          <tr className="row">
            <th scope="row">On disk</th>
            <td className="mono">{(store.databaseBytes / 1_048_576).toFixed(1)} MiB</td>
            <td className="table__prose">
              The whole database file, not the memory tables alone — honest about being an
              over-estimate.
            </td>
          </tr>
        </tbody>
      </table>

      <h3 className="panel__subtitle">Inferred weight, and where the mass sits</h3>
      <Histogram
        buckets={store.inferredWeights.buckets}
        total={store.inferredWeights.total}
        bottomHeavy={store.inferredWeights.bottomHeavy}
        basis={store.inferredWeights.basis}
      />

      <table className="table table--dense">
        <caption className="table__caption">The judgements</caption>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col">Reading</th>
            <th scope="col">What it says</th>
          </tr>
        </thead>
        <tbody>
          <tr className="row">
            <th scope="row">Survival</th>
            <RateCell rate={survival.overall} testId="survival-rate" />
            <td className="table__prose">
              Of the edges a night created, what is still above the floor. Insight against noise, in
              one number.
              {survival.vanished > 0 && (
                <strong>
                  {" "}
                  {survival.vanished} edge(s) the log says were created are GONE from the graph. An
                  inference is never deleted; this is a breach.
                </strong>
              )}
            </td>
          </tr>
          <tr className="row">
            <th scope="row">Reactivation</th>
            <RateCell rate={reactivation.rate} testId="reactivation-rate" />
            <td className="table__prose">{reactivation.verdict.headline}</td>
          </tr>
          <tr className="row">
            <th scope="row">You engaged</th>
            <RateCell rate={engagement.engagedRate} testId="engaged-rate" />
            <td className="table__prose">
              Of what she surfaced and you answered. {engagement.surfaced} surfaced,{" "}
              {engagement.answered} answered.
            </td>
          </tr>
          <tr className="row">
            <th scope="row">You rejected</th>
            <RateCell rate={engagement.rejectedRate} testId="rejected-rate" />
            <td className="table__prose">
              A class of connection you consistently reject is data saying stop generating it.
            </td>
          </tr>
          <tr className="row">
            <th scope="row">You ignored</th>
            <RateCell rate={engagement.ignoredRate} testId="ignored-rate" />
            <td className="table__prose">
              Silence counts, after a week. Without that, &ldquo;ignored&rdquo; is unmeasurable.
            </td>
          </tr>
          <tr className="row">
            <th scope="row">Tokens per kept edge</th>
            <RateCell rate={cost.tokensPerKeptEdge} testId="tokens-per-kept-edge" digits={0} unit="" />
            <td className="table__prose">
              {cost.tokensSpent} token(s) and {formatCost(cost.costUsd)} spent, {cost.edgesKept}{" "}
              edge(s) kept.
              {cost.keptNothing && (
                <strong> Spent and kept nothing: the cost per kept edge is unbounded, not zero.</strong>
              )}
              {cost.understated && (
                <strong>
                  {" "}
                  A turn was killed by the timeout and never reported its usage, so every figure
                  here is a FLOOR.
                </strong>
              )}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

/**
 * A ratio, or the reason there is not one.
 *
 * The branch is the whole component. `known === false` renders the server's own
 * sentence in the muted style used for "there is nothing to say", and renders
 * **no number and no bar** — because a zero-length bar is a zero, drawn.
 */
export function RateCell({
  rate,
  testId,
  digits = 0,
  unit = "%",
}: {
  readonly rate: Rate;
  readonly testId: string;
  readonly digits?: number;
  readonly unit?: string;
}): ReactElement {
  const reading = describeRate(rate, digits);
  if (!reading.known) {
    return (
      <td className="table__prose" data-testid={testId} data-known="false">
        <span className="rate rate--undefined">not a rate</span>
        <span className="row__sub">{reading.text}</span>
      </td>
    );
  }
  const percentage = unit === "%" ? reading.text : (rate.value ?? 0).toFixed(digits);
  return (
    <td data-testid={testId} data-known="true">
      <span className="mono">{percentage}</span>
      <span className="row__sub mono">{reading.counts}</span>
    </td>
  );
}

/** The weight distribution, and the one number in it that carries signal. */
export function Histogram({
  buckets,
  total,
  bottomHeavy,
  basis,
}: {
  readonly buckets: readonly WeightBucket[];
  readonly total: number;
  readonly bottomHeavy: Rate;
  readonly basis: string;
}): ReactElement {
  const reading = describeRate(bottomHeavy, 0);
  const tallest = buckets.reduce((most, bucket) => Math.max(most, bucket.count), 0);

  return (
    <div data-testid="weight-histogram">
      {total === 0 ? (
        // Not a row of empty bars. An empty histogram drawn as bars of length
        // zero looks like a measured, flat distribution; it is the absence of
        // one.
        <p className="feedback feedback--empty" data-testid="histogram-empty">
          There are no inferred edges yet, so the histogram has no shape. An empty store is not a
          healthy one — it is an unstarted one.
        </p>
      ) : (
        <ul className="histogram">
          {buckets.map((bucket) => (
            <li className="histogram__bar" key={bucket.from}>
              <span className="histogram__label mono">{bucket.from.toFixed(1)}</span>
              <span
                className="histogram__fill"
                style={{ inlineSize: `${String(tallest === 0 ? 0 : (bucket.count / tallest) * 100)}%` }}
              />
              <span className="histogram__count mono">
                {bucket.count} ({bucket.hot}/{bucket.cold}/{bucket.suppressed})
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="view__note" data-testid="bottom-heavy">
        Bottom tenth:{" "}
        {reading.known ? (
          <strong>{reading.text}</strong>
        ) : (
          <em>{reading.text}</em>
        )}
        . Mass piled down there means she is manufacturing connections nothing ever confirms.
        Weights read as <code>{basis}</code>.
      </p>
    </div>
  );
}
