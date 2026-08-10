import { useCallback, useState, type ReactElement } from "react";

import { useResource, type Loader } from "../../api/use-resource";
import { pluralise } from "../../format/text";
import { Empty, ErrorNotice, Loading } from "../../ui/feedback";
import { AlarmBanner } from "./AlarmBanner";
import { ColdStorePanel } from "./ColdStorePanel";
import { DreamPanel } from "./DreamPanel";
import { EdgeTable } from "./EdgeTable";
import { GraphCanvas } from "./GraphCanvas";
import { MetricsPanel } from "./MetricsPanel";
import { emptyStateOf, type MemoryGraphView, type MemoryMetricsView } from "./memory-model";
import { useEdgeVerdict, useMemoryClient } from "./use-memory";

/**
 * The memory graph, visible — and correctable.
 *
 * The Commander asked for this by name: *"I would love to see the graph in the
 * admin tool while developing — I want to see how the memory system evolves and
 * what it creates that is relevant, and how relevant the inferred engine is."*
 *
 * Four things follow from that sentence and they decide this file:
 *
 * 1. **The two species are drawn differently and unmistakably** — solid against
 *    dashed, in the picture and in the table. See `GraphCanvas`.
 * 2. **Weight is drawn rather than printed**, and it is the *decayed* weight, so
 *    the decay curve is visible at a glance rather than something to query.
 * 3. **It is a correction surface.** Reject and confirm are in the table from
 *    the first version, because they are the cheapest high-quality signal this
 *    system will ever get and retrofitting them means retrofitting the API too.
 * 4. **The invariant alarm sits above everything** and is never merged into a
 *    generic error count. See `AlarmBanner`.
 *
 * ## Scope, said out loud
 *
 * This is the hot region plus the last N nights, never the whole store — the
 * graph will outgrow naive rendering long before SQLite minds. The server says
 * what it left out in `scope.explanation` and this view prints it, because a
 * slice presented in silence is read as the whole thing.
 *
 * ## The empty state is the state he will see first
 *
 * Nothing has run yet. `emptyStateOf` separates *no dream has ever executed*
 * from *dreams ran and the hot region is still empty*, and only the second is
 * worth worrying about. Neither is allowed to look like a failed request — that
 * is what the error notice is for, and it is deliberately the loudest thing on
 * the page.
 */

/** The nights of dream output on offer. A week is the default reading. */
const NIGHT_WINDOWS: readonly number[] = [1, 3, 7, 14, 30];

export function MemoryView(): ReactElement {
  const client = useMemoryClient();
  const [nights, setNights] = useState(7);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const loadGraph = useCallback<Loader<MemoryGraphView>>(
    (signal) => {
      if (client === null) return Promise.reject(new Error("signed out"));
      return client.graph({ nights }, { signal });
    },
    [client, nights],
  );
  const loadMetrics = useCallback<Loader<MemoryMetricsView>>(
    (signal) => {
      if (client === null) return Promise.reject(new Error("signed out"));
      return client.metrics({ signal });
    },
    [client],
  );

  const graph = useResource<MemoryGraphView>(client === null ? null : loadGraph);
  const metrics = useResource<MemoryMetricsView>(client === null ? null : loadMetrics);

  // A verdict changes the edge's tier and its weight, so both the picture and
  // the panel are stale the moment one lands. Reloading both is cheap — this is
  // a panel a human opens, not a hot path — and a view that showed a rejected
  // edge as still live would be lying about the one thing it is for.
  const reloadBoth = useCallback(() => {
    graph.reload();
    metrics.reload();
  }, [graph, metrics]);
  const verdict = useEdgeVerdict(client, { onSettled: reloadBoth });

  const view = graph.data;
  const empty = view === null ? null : emptyStateOf(view);

  return (
    <section className="view view--wide">
      <h1 className="view__title">Memory</h1>
      <p className="view__lede">
        The graph as it stands, the edges with their weights <em>and their reasoning</em>, what the
        last nights of reflection produced, and what was superseded. Every connection here can be
        confirmed or killed — that is a write into Syl&rsquo;s memory, not a bookmark.
      </p>

      {/* Above everything, always. The alarm that distinguishes "nothing
          deserved reactivation" from "reactivation is broken" cannot be
          something he has to scroll to. */}
      {metrics.data !== null && <AlarmBanner alarm={metrics.data.alarm} />}

      <div className="toolbar">
        <label className="field field--inline">
          Nights of reflection
          <select
            className="field__select"
            value={nights}
            onChange={(event) => {
              setNights(Number(event.target.value));
            }}
          >
            {NIGHT_WINDOWS.map((option) => (
              <option key={option} value={option}>
                {pluralise(option, "night")}
              </option>
            ))}
          </select>
        </label>

        <button className="button" type="button" onClick={reloadBoth} disabled={graph.loading}>
          {graph.loading ? "Refreshing…" : "Refresh"}
        </button>

        <span className="toolbar__count">
          {view === null
            ? ""
            : `${pluralise(view.nodes.length, "node")}, ${pluralise(view.edges.length, "edge")}`}
        </span>
      </div>

      {graph.error !== null && <ErrorNotice error={graph.error} onRetry={graph.reload} />}
      {graph.error?.code === "FORBIDDEN" && <KeyNotAccepted />}
      {graph.error === null && graph.loading && view === null && (
        <Loading label="Reading the graph…" />
      )}

      {view !== null && empty !== null && empty.reason !== "not_empty" && (
        <div className="notice" data-testid="memory-empty" data-reason={empty.reason}>
          <div className="notice__head">
            <strong>{empty.headline}</strong>
          </div>
          <p className="notice__body">{empty.body}</p>
          <p className="notice__meta mono">
            This panel reached the service and the service answered. An empty store is not a failed
            request — a failure would be the red notice, not this one.
          </p>
        </div>
      )}

      {view !== null && view.edges.length > 0 && (
        <>
          <GraphCanvas
            nodes={view.nodes}
            edges={view.edges}
            law={view.law}
            selectedEdgeId={selectedEdgeId}
            onSelectEdge={setSelectedEdgeId}
          />

          <p className="view__note" data-testid="scope-note">
            {view.scope.explanation}
            {view.scope.edgeBudgetExhausted &&
              " The edge budget was reached before the hot region ran out, so there is more up there than is drawn."}
            {view.scope.moreNights && " There are older nights beyond this window."}
          </p>

          <EdgeTable
            edges={view.edges}
            nodes={view.nodes}
            verdict={verdict}
            selectedEdgeId={selectedEdgeId}
            onSelectEdge={setSelectedEdgeId}
          />
        </>
      )}

      {view !== null && (
        <DreamPanel
          nights={view.nights}
          superseded={view.superseded}
          dreamHasEverRun={view.scope.dreamHasEverRun}
          windowNights={nights}
        />
      )}

      {metrics.error !== null && <ErrorNotice error={metrics.error} onRetry={metrics.reload} />}
      {metrics.error === null && metrics.loading && metrics.data === null && (
        <Loading label="Computing the metrics…" />
      )}
      {metrics.data !== null && <MetricsPanel metrics={metrics.data} />}
      {/* The cold store gets its own panel rather than a row in the table
          above, because half of it is not a number: the handful of dormant
          edges with their reasoning is the one thing here that no aggregate
          can substitute for. */}
      {metrics.data !== null && (
        <ColdStorePanel
          shape={metrics.data.cold.shape}
          sample={metrics.data.cold.sample}
          resurrection={metrics.data.cold.resurrection}
        />
      )}
      {metrics.data === null && metrics.error === null && !metrics.loading && (
        <Empty>The metrics have not been read yet.</Empty>
      )}
    </section>
  );
}

/**
 * The refusal, rendered as a next step.
 *
 * Same argument as the logs view, and one step stronger: this surface *writes*
 * into Syl's memory, so a paired phone must not reach it. A device key is still
 * a working key everywhere else, so the 403 is an instruction rather than a
 * reason to sign anybody out.
 */
/**
 * Shown when the service will not accept this browser's key at all.
 *
 * It used to say "this needs a key with admin scope, run `pair -- --admin`",
 * which was true until the Commander ruled otherwise on 2026-08-10: no second
 * key for the admin panel. Leaving that copy would have been a screen telling
 * him to perform a workflow that no longer exists — the stale-instruction
 * failure, in the one place he would actually read it.
 */
function KeyNotAccepted(): ReactElement {
  return (
    <div className="notice" data-testid="key-not-accepted">
      <p className="notice__body">
        This view needs a key the service recognises, and the one in this browser was not
        accepted. Sign in again with a token from <code>npm run pair</code>.
      </p>
    </div>
  );
}
