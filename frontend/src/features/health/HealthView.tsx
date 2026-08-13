import { useMemo, useState, type ReactElement } from "react";

import { formatInstant } from "../../format/time";
import { Badge } from "../../ui/Badge";
import { ErrorNotice, Loading } from "../../ui/feedback";
import {
  DEFAULT_WINDOW_ID,
  HEALTH_TYPES,
  STANDINGS,
  TYPE_LABELS,
  authorisationDisagrees,
  fleetHeadline,
  fleetTone,
  formatCount,
  formatValue,
  isHistoricOnly,
  pointsAttribute,
  readingOf,
  sparklineSegments,
  standingDescriptor,
  summarise,
  summariseTypes,
  windowChoice,
  windowRange,
  type HealthSample,
  type Standing,
  type WindowRange,
  WINDOWS,
} from "./health-model";
import { asLoad, useHealthClient, useHealthWindow, type TypeState } from "./use-health";

/**
 * The raw health data, per type, over a window he chooses.
 *
 * His ruling: the admin shows the raw data, not only what she made of it.
 *
 *
 * ## The rule this view is built around
 *
 * **An empty panel never looks the same twice.** There are four reasons a type
 * can have nothing in it and they are four different facts:
 *
 * 1. Authorised, and nothing happened. A baseline is drawn, because the zero was
 *    measured.
 * 2. Quiet that proves nothing — undisclosed (the common case: iOS will not
 *    confirm a read grant), never asked, HealthKit absent, refused, or never
 *    reported at all. **Nothing is drawn.** The panel is hatched and says so in
 *    words, and it says a different thing for each of the five — including
 *    "there is nothing you can do", which is the honest answer for two of them
 *    and is not the same answer as "go and change a setting".
 * 3. The request failed. Not an absence of data and not a permission problem —
 *    the ordinary error notice, which is the loudest thing on the page.
 * 4. Still in flight.
 *
 * A chart library given an empty array draws case 1 for all four. That is the
 * whole bug: every layer reports success and the only symptom is a flat line
 * that reads as a quiet day. `syl-kqc` is the precedent — a capability the
 * binary never had, accepted and downgraded silently, with no layer recording an
 * error.
 *
 * The distinction is carried on four independent channels, because any one of
 * them can be lost: the words, the colour, a glyph (a screenshot in a thread, a
 * colour-blind reader), and the presence or absence of a drawn line. It is also
 * on the DOM as `data-reading` and `data-standing`, which is what the tests
 * assert — a test that greps for prose is a test that a copy-edit turns red.
 */

const SPARK = { width: 320, height: 40 } as const;

/** How many rows the raw table shows before it is a wall rather than evidence. */
const RAW_ROWS = 50;

export interface HealthViewProps {
  /**
   * Pinned instant. Omitted, the real clock is used.
   *
   * The window is relative — "last 24 hours" — so without this seam every
   * assertion about which samples fall inside it would be a statement about the
   * day the test was run. That failure has already happened five times in this
   * project; `DevicesView` carries the same seam for the same reason.
   */
  readonly now?: Date | undefined;
}

export function HealthView({ now: pinnedNow }: HealthViewProps): ReactElement {
  const client = useHealthClient();
  const [windowId, setWindowId] = useState(DEFAULT_WINDOW_ID);

  const choice = windowChoice(windowId);
  // Pinned per window change rather than per render: a range that moved every
  // render would re-fetch seven series continuously.
  const range = useMemo<WindowRange>(
    () => windowRange(choice, pinnedNow ?? new Date()),
    [choice, pinnedNow],
  );

  const health = useHealthWindow(client, range);
  const settled = health.types.filter((state) => !state.pending);
  const summary = useMemo(() => summariseTypes(settled.map(asLoad)), [health.types]);

  return (
    <section className="view view--wide">
      <h1 className="view__title">Health</h1>
      <p className="view__lede">
        Every stored type over the chosen window, with its source. A type with nothing in it is
        never rendered as a flat line unless the flat line was <em>measured</em> — “he took no
        steps this week” and “we have never been able to see his heart rate variability” are
        different facts, and only the first is about his body. The second is drawn as no chart at
        all.
      </p>

      {settled.length > 0 && (
        <div className="banner" data-testid="health-summary">
          <Badge tone={fleetTone(summary)}>{fleetHeadline(summary)}</Badge>
        </div>
      )}

      <div className="toolbar">
        <label className="field field--inline">
          <span className="field__label">Window</span>
          <select
            className="field__select"
            value={windowId}
            onChange={(event) => {
              setWindowId(event.target.value);
            }}
          >
            {WINDOWS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button className="button" type="button" onClick={health.reload} disabled={health.loading}>
          {health.loading ? "Refreshing…" : "Refresh"}
        </button>
        <span className="toolbar__count mono">
          {formatInstant(range.from)} → {formatInstant(range.to)}
        </span>
      </div>

      <StandingKey />

      <div className="health__types">
        {HEALTH_TYPES.map((type) => {
          const state = health.types.find((candidate) => candidate.type === type);
          return state === undefined ? null : (
            <TypePanel key={type} state={state} range={range} onRetry={health.reload} />
          );
        })}
      </div>
    </section>
  );
}

/**
 * The six standings, spelled out once.
 *
 * Not decoration. The chips on the panels are short by necessity and the
 * difference between `denied` and `undisclosed` is the difference between "go
 * and change a setting" and "there is nothing you can do" — which is exactly the
 * distinction a collapsed display destroys.
 */
function StandingKey(): ReactElement {
  // `undisclosed` sits second because it is the COMMON case on this platform,
  // not an edge one — iOS will not confirm a read grant, so it is what his
  // empty types actually carry. `denied` sits near the bottom for the opposite
  // reason: no current client can produce it.
  const order: readonly Standing[] = [
    "authorised",
    "undisclosed",
    "notDetermined",
    "unavailable",
    "denied",
    "unreported",
  ];

  return (
    <details className="panel" data-testid="standing-key">
      <summary className="panel__title">What each permission state means for an empty panel</summary>
      <dl className="legend">
        {order.map((standing) => {
          const descriptor = STANDINGS[standing];
          return (
            <div className="legend__item" key={standing} data-standing={standing}>
              <dt>
                <Badge tone={descriptor.tone} title={standing}>
                  <span aria-hidden="true">{descriptor.mark}</span> {descriptor.label}
                </Badge>
              </dt>
              <dd>
                {descriptor.silenceMeans}
                {descriptor.remedy !== null && (
                  <span className="row__sub">Remedy: {descriptor.remedy}</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}

interface TypePanelProps {
  readonly state: TypeState;
  readonly range: WindowRange;
  readonly onRetry: () => void;
}

function TypePanel({ state, range, onRetry }: TypePanelProps): ReactElement {
  const load = asLoad(state);
  const reading = readingOf(load);
  const descriptor = standingDescriptor(state.series?.state ?? null);
  const samples = state.series?.samples ?? [];
  const summary = summarise(samples);
  const unit = state.series?.unit ?? "";

  return (
    <article
      className="panel health__type"
      data-testid={`health-type-${state.type}`}
      data-reading={state.pending ? "pending" : reading}
      data-standing={state.pending ? "" : descriptor.standing}
      data-evidence={String(reading === "measuredZero")}
    >
      <header className="detail__head">
        <h2 className="panel__title">{TYPE_LABELS[state.type]}</h2>
        <Badge tone={descriptor.tone} title={`authorisation: ${descriptor.standing}`}>
          <span aria-hidden="true">{descriptor.mark}</span> {descriptor.label}
        </Badge>
      </header>

      {state.pending && <Loading label={`Reading ${TYPE_LABELS[state.type]}…`} />}

      {!state.pending && reading === "failed" && state.error !== null && (
        <>
          <p className="notice__body">
            This type could not be <strong>asked about</strong>. It is not empty and it is not
            unauthorised — nothing here says anything about his body.
          </p>
          <ErrorNotice error={state.error} onRetry={onRetry} />
        </>
      )}

      {!state.pending && reading === "samples" && state.series !== null && (
        <>
          <Sparkline samples={samples} range={range} />
          <dl className="legend">
            <div className="legend__item">
              <dt>Samples in window</dt>
              <dd className="mono">{formatCount(summary.count)}</dd>
            </div>
            <div className="legend__item">
              <dt>Sources</dt>
              <dd data-testid={`health-sources-${state.type}`}>
                {summary.sources
                  .map((source) => `${source.source} (${formatCount(source.count)})`)
                  .join(" · ")}
              </dd>
            </div>
            <div className="legend__item">
              <dt>Range</dt>
              <dd className="mono">
                {formatValue(summary.min, unit)} … {formatValue(summary.max, unit)} · mean{" "}
                {formatValue(summary.mean, unit)}
              </dd>
            </div>
            <div className="legend__item">
              <dt>In this window</dt>
              <dd className="mono">
                {formatInstant(summary.first)} → {formatInstant(summary.last)}
              </dd>
            </div>
          </dl>

          {summary.truncated && (
            <p className="notice notice--fail" role="alert" data-testid={`health-capped-${state.type}`}>
              Capped at {formatCount(summary.count)} rows. The route returns the <em>oldest</em>{" "}
              matches first and offers no limit, so the newest samples in this window are missing
              from the chart. Narrow the window to see them.
            </p>
          )}

          {isHistoricOnly(load) && (
            <p className="notice" data-testid={`health-historic-${state.type}`}>
              These rows are held from before. The phone is not currently proven able to read this
              type ({descriptor.label}), so nothing new should be expected here.
            </p>
          )}
        </>
      )}

      {!state.pending && reading === "measuredZero" && (
        <div className="silence silence--measured" data-testid={`health-silence-${state.type}`}>
          {/* A baseline, drawn on purpose. This is the ONE empty case where a
              flat line is honest: the type is authorised, so the zero was
              measured. */}
          <svg
            className="silence__baseline"
            viewBox={`0 0 ${String(SPARK.width)} ${String(SPARK.height)}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="a measured baseline: authorised, and nothing happened"
          >
            <line x1="0" y1={SPARK.height - 1} x2={SPARK.width} y2={SPARK.height - 1} />
          </svg>
          <p className="silence__text">
            <strong>{descriptor.headline}</strong> {descriptor.silenceMeans}
          </p>
        </div>
      )}

      {!state.pending && reading === "notLooked" && (
        <div className="silence silence--unlooked" data-testid={`health-silence-${state.type}`}>
          {/* Deliberately no <svg>. Any line here would be a measurement nobody
              took. The hatching is what fills the space instead. */}
          <p className="silence__text">
            <strong>{descriptor.headline}</strong> {descriptor.silenceMeans}
          </p>
          {descriptor.remedy !== null && (
            <p className="silence__remedy">
              <strong>Remedy:</strong> {descriptor.remedy}
            </p>
          )}
        </div>
      )}

      {!state.pending && state.series !== null && authorisationDisagrees(state.series) && (
        <p className="notice notice--fail" role="alert" data-testid={`health-disagrees-${state.type}`}>
          The server sent <code>silenceIsEvidence: {String(state.series.silenceIsEvidence)}</code>{" "}
          beside <code>state: {String(state.series.state)}</code>. Those disagree. This panel has
          been rendered the cautious way.
        </p>
      )}

      {!state.pending && state.series !== null && (
        <p className="panel__subtitle mono" data-testid={`health-provenance-${state.type}`}>
          newest held (all time): {formatInstant(state.series.watermark)} · permission reported:{" "}
          {formatInstant(state.series.reportedAt)}
        </p>
      )}

      {samples.length > 0 && <RawRows type={state.type} samples={samples} unit={unit} />}
    </article>
  );
}

function Sparkline({
  samples,
  range,
}: {
  readonly samples: readonly HealthSample[];
  readonly range: WindowRange;
}): ReactElement {
  const segments = sparklineSegments(samples, range, SPARK);
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${String(SPARK.width)} ${String(SPARK.height)}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${String(samples.length)} samples over the window`}
      data-segments={String(segments.length)}
    >
      {segments.map((segment, index) => {
        // Segments have no identity beyond their order in the window.
        const key = `${String(index)}-${pointsAttribute(segment).slice(0, 16)}`;
        const only = segment.length === 1 ? segment[0] : undefined;
        // A one-bucket run is a real measurement and a `polyline` of one point
        // renders as nothing at all — which would delete an isolated burst from
        // the chart while every count beside it still said it was there.
        return only === undefined ? (
          <polyline key={key} className="spark__line" points={pointsAttribute(segment)} />
        ) : (
          <circle key={key} className="spark__dot" cx={only.x} cy={only.y} r={2} />
        );
      })}
    </svg>
  );
}

/**
 * The rows themselves.
 *
 * The newest first, because "is it still arriving" is the question the raw table
 * is opened to answer — and the store hands them over oldest-first, so this
 * reverses rather than trusting the order.
 */
function RawRows({
  type,
  samples,
  unit,
}: {
  readonly type: string;
  readonly samples: readonly HealthSample[];
  readonly unit: string;
}): ReactElement {
  const rows = [...samples].slice(-RAW_ROWS).reverse();

  return (
    <details className="health__raw">
      <summary>
        Raw rows — newest {formatCount(rows.length)} of {formatCount(samples.length)} returned
      </summary>
      <table className="table table--dense" data-testid={`health-rows-${type}`}>
        <caption className="table__caption">{type} samples</caption>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Ended</th>
            <th scope="col">Value</th>
            <th scope="col">Source</th>
            <th scope="col">Recorded</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((sample) => (
            <tr className="row" key={`${sample.startedAt}|${sample.endedAt}|${sample.source}`}>
              <th scope="row" className="mono">
                {formatInstant(sample.startedAt)}
              </th>
              <td className="mono">{formatInstant(sample.endedAt)}</td>
              <td className="mono">{formatValue(sample.value, unit)}</td>
              <td>{sample.source}</td>
              <td className="mono">{formatInstant(sample.recordedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
