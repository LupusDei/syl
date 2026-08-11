import { useCallback, useMemo, useState, type ReactElement } from "react";

import type { LogEntry, LogLevel, LogPage } from "@syl/shared/types";

import { useAdminClient } from "../../api/use-admin-client";
import { useResource, type Loader } from "../../api/use-resource";
import { formatInstant } from "../../format/time";
import { humanise, pluralise } from "../../format/text";
import { Badge } from "../../ui/Badge";
import { Empty, ErrorNotice, Loading } from "../../ui/feedback";
import {
  describeEntry,
  EVENT_FILTERS,
  isToolCall,
  levelTone,
  LOG_LEVELS,
  startOfLocalDay,
  tallyTools,
  toolOf,
} from "./log-model";

/**
 * What Syl has been doing.
 *
 * Syl runs on the Commander's machine pre-authorised. Until this view he could
 * talk to her from his phone and had no way to see what she *did* — which is
 * backwards. The default the view opens on is therefore not "the whole log": it
 * is **today's tool calls**, because "every tool she has called today" is the
 * question, and a view that opens on a wall of `service.notice` lines makes him
 * do the filtering that this page exists to have already done.
 *
 * ## It needs an admin key, and says so when it does not have one
 *
 * `GET /logs` refuses a device-scoped token with `FORBIDDEN`. That is not a
 * broken session — the same key works everywhere else in this admin — so the
 * refusal is rendered here as an instruction rather than being allowed to
 * bounce the operator back to the sign-in gate. `api/authed-fetch.ts` stopped
 * signing out on 403 for exactly this reason.
 */
export function LogsView(): ReactElement {
  const client = useAdminClient();
  const [prefix, setPrefix] = useState<string>("turn.tool");
  const [level, setLevel] = useState<LogLevel | "">("");
  const [todayOnly, setTodayOnly] = useState(true);
  // Frozen per render pass rather than read inside the loader: "today" must not
  // change between the request that was sent and the label describing it.
  const since = useMemo(
    () => (todayOnly ? startOfLocalDay(new Date()) : null),
    [todayOnly],
  );

  const load = useCallback<Loader<LogPage>>(
    (signal) => {
      if (client === null) return Promise.reject(new Error("signed out"));
      return client.listLogs(
        {
          ...(prefix === "" ? {} : { event: prefix }),
          ...(level === "" ? {} : { level }),
          ...(since === null ? {} : { since }),
          limit: 200,
        },
        { signal },
      );
    },
    [client, prefix, level, since],
  );
  const logs = useResource<LogPage>(client === null ? null : load);

  const rows = logs.data?.items ?? [];
  const tools = useMemo(() => tallyTools(rows), [rows]);
  const scope = EVENT_FILTERS.find((filter) => filter.prefix === prefix);

  return (
    <section className="view view--wide">
      <h1 className="view__title">Logs</h1>
      <p className="view__lede">
        Syl&rsquo;s own structured log, newest first. She runs pre-authorised on this machine, so{" "}
        <code>turn.tool</code> is the line that matters: it is the record of what she actually did.
      </p>

      <div className="toolbar">
        <label className="field field--inline">
          Showing
          <select
            className="field__select"
            value={prefix}
            onChange={(event) => {
              setPrefix(event.target.value);
            }}
          >
            {EVENT_FILTERS.map((filter) => (
              <option key={filter.label} value={filter.prefix}>
                {filter.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--inline">
          Level
          <select
            className="field__select"
            value={level}
            onChange={(event) => {
              setLevel(event.target.value as LogLevel | "");
            }}
          >
            <option value="">any</option>
            {LOG_LEVELS.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--inline">
          <input
            type="checkbox"
            checked={todayOnly}
            onChange={(event) => {
              setTodayOnly(event.target.checked);
            }}
          />
          Today only
        </label>

        <button className="button" type="button" onClick={logs.reload} disabled={logs.loading}>
          {logs.loading ? "Refreshing…" : "Refresh"}
        </button>

        <span className="toolbar__count">
          {logs.data === null ? "" : pluralise(rows.length, "record")}
          {logs.data?.hasMore === true && " (more beyond this page)"}
        </span>
      </div>

      {scope !== undefined && <p className="view__note">{scope.summary}</p>}

      {logs.error !== null && <ErrorNotice error={logs.error} onRetry={logs.reload} />}
      {logs.error?.code === "FORBIDDEN" && <KeyNotAccepted />}
      {logs.error === null && logs.loading && logs.data === null && (
        <Loading label="Reading the log…" />
      )}
      {logs.error === null && logs.data !== null && rows.length === 0 && (
        <Empty>
          Nothing matches this filter. Nothing is being hidden — the service returned no records.
        </Empty>
      )}

      {tools.length > 0 && (
        <p className="view__note" data-testid="tool-tally">
          Tools called: {tools.map((tally) => `${tally.tool} ×${String(tally.count)}`).join(", ")}
        </p>
      )}

      {rows.length > 0 && (
        <table className="table table--dense">
          <caption className="table__caption">Log</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Level</th>
              <th scope="col">Event</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry, index) => (
              <LogRow key={`${entry.ts}-${String(index)}`} entry={entry} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function LogRow({ entry }: { entry: LogEntry }): ReactElement {
  const tool = toolOf(entry);
  return (
    <tr className={isToolCall(entry) ? "row row--selected" : "row"}>
      <th scope="row" className="mono">
        {formatInstant(entry.ts)}
      </th>
      <td>
        <Badge tone={levelTone(entry.level)} title={entry.level}>
          {entry.level}
        </Badge>
      </td>
      <td className="mono">
        {entry.event}
        <span className="row__sub mono">pid {entry.pid}</span>
      </td>
      <td className="table__prose">
        {tool === null ? (
          describeEntry(entry)
        ) : (
          // The tool name is the payload of the whole view, so it is the one
          // cell that is never prose.
          <strong className="mono">{tool}</strong>
        )}
      </td>
    </tr>
  );
}

/**
 * The refusal, rendered as a next step.
 *
 * A device key is a *working* key — it is what every other view here uses — so
 * "forbidden" alone reads as a bug in the admin rather than as the deliberate
 * boundary it is.
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
