import { useCallback, useMemo, useState, type ReactElement } from "react";

import type { Delivery, DeliveryPage, DeliveryState } from "@syl/shared/types";

import { useAdminClient } from "../../api/use-admin-client";
import { useResource, type Loader } from "../../api/use-resource";
import { formatDuration, formatInstant } from "../../format/time";
import { firstLine, humanise, pluralise, shortId } from "../../format/text";
import { Badge } from "../../ui/Badge";
import { Empty, ErrorNotice, Loading } from "../../ui/feedback";
import {
  ackLatencyMs,
  coalescedCount,
  DELIVERY_STATES,
  deliveryStateTone,
  describeEngagement,
  sortDeliveries,
  standingLabel,
  standingOf,
  standingTone,
  summariseOutbox,
  summaryHeadline,
  summaryTone,
  unconfirmedForMs,
} from "./delivery-model";

/**
 * The outbox: what was sent, what was retried, and what is still unconfirmed.
 *
 * This is how the never-drop guarantee is *proved* rather than asserted, so
 * the design brief is narrow: an unconfirmed reminder must be impossible to
 * miss. Three things do that work —
 *
 * 1. A banner that leads with the unconfirmed count and is toned by the worst
 *    standing on the page, so the answer is visible before any row is read.
 * 2. The default filter is `unacknowledged`, which the contract itself calls
 *    "the interesting view" — with the filter stated in words, so an empty
 *    table is never mistaken for an empty outbox.
 * 3. A dedicated standing column that says `unconfirmed` and for how long.
 *    `state: delivered` is shown too, and deliberately not coloured as
 *    success: APNs accepting a request is not the notification arriving.
 */
export function DeliveryView(): ReactElement {
  const client = useAdminClient();
  const [unacknowledgedOnly, setUnacknowledgedOnly] = useState(true);
  const [state, setState] = useState<DeliveryState | "">("");

  const load = useCallback<Loader<DeliveryPage>>(
    (signal) => {
      if (client === null) return Promise.reject(new Error("signed out"));
      return client.listDeliveries(
        {
          ...(unacknowledgedOnly ? { unacknowledged: true } : {}),
          ...(state === "" ? {} : { state }),
        },
        { signal },
      );
    },
    [client, unacknowledgedOnly, state],
  );
  const outbox = useResource<DeliveryPage>(client === null ? null : load);

  const items = outbox.data?.items ?? [];
  const now = useMemo(() => new Date(), [outbox.data]);
  const rows = useMemo(() => sortDeliveries(items), [items]);
  const summary = useMemo(() => summariseOutbox(items), [items]);

  return (
    <section className="view view--wide">
      <h1 className="view__title">Delivery outbox</h1>
      <p className="view__lede">
        A row counts as delivered only when the <strong>device</strong> acknowledges it. APNs
        accepting a request is not arrival — Apple keeps only the most recent notification per app
        while a device is offline, so a night of reminders can collapse into one.
      </p>

      {outbox.data !== null && (
        <div className="banner" data-testid="outbox-summary">
          <Badge tone={summaryTone(summary)}>{summaryHeadline(summary)}</Badge>
          <span className="banner__counts mono">
            {summary.abandoned} never confirmed · {summary.awaitingAck} awaiting ack ·{" "}
            {summary.inFlight} in flight · {summary.acknowledged} acknowledged
          </span>
        </div>
      )}

      <div className="toolbar">
        <label className="field field--inline">
          <input
            type="checkbox"
            checked={unacknowledgedOnly}
            onChange={(event) => {
              setUnacknowledgedOnly(event.target.checked);
            }}
          />
          Unacknowledged only
        </label>

        <label className="field field--inline">
          State
          <select
            className="field__select"
            value={state}
            onChange={(event) => {
              setState(event.target.value as DeliveryState | "");
            }}
          >
            <option value="">any</option>
            {DELIVERY_STATES.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </select>
        </label>

        <button className="button" type="button" onClick={outbox.reload} disabled={outbox.loading}>
          {outbox.loading ? "Refreshing…" : "Refresh"}
        </button>

        <span className="toolbar__count">
          {unacknowledgedOnly ? "showing unacknowledged rows only" : "showing every row"}
          {state === "" ? "" : `, state ${humanise(state)}`}
        </span>
      </div>

      {outbox.error !== null && <ErrorNotice error={outbox.error} onRetry={outbox.reload} />}
      {outbox.error === null && outbox.loading && outbox.data === null && (
        <Loading label="Loading the outbox…" />
      )}
      {outbox.error === null && outbox.data !== null && rows.length === 0 && (
        <Empty>
          {unacknowledgedOnly
            ? "Nothing unacknowledged. Clear the filter to see the whole outbox."
            : "The outbox is empty."}
        </Empty>
      )}

      {rows.length > 0 && (
        <table className="table table--dense">
          <caption className="table__caption">Outbox</caption>
          <thead>
            <tr>
              <th scope="col">Standing</th>
              <th scope="col">State</th>
              <th scope="col">Message</th>
              <th scope="col">Scheduled</th>
              <th scope="col">Reached APNs</th>
              <th scope="col">Acknowledged</th>
              <th scope="col">Attempts</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((delivery) => (
              <DeliveryRow key={delivery.id} delivery={delivery} now={now} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function DeliveryRow({ delivery, now }: { delivery: Delivery; now: Date }): ReactElement {
  const standing = standingOf(delivery);
  const waiting = unconfirmedForMs(delivery, now);
  const latency = ackLatencyMs(delivery);
  const coalesced = coalescedCount(delivery);

  return (
    <tr className={standing === "acknowledged" ? "row" : "row row--unconfirmed"}>
      <th scope="row">
        <Badge tone={standingTone(standing)} title={delivery.id}>
          {standingLabel(standing)}
        </Badge>
        {waiting !== null && (
          <span className="row__sub" data-testid="waiting-for">
            for {formatDuration(waiting)}
          </span>
        )}
      </th>
      <td>
        <Badge tone={deliveryStateTone(delivery.state)} title={delivery.state}>
          {humanise(delivery.state)}
        </Badge>
        {delivery.late && <span className="row__sub cell--late">late</span>}
      </td>
      <td className="table__prose">
        {firstLine(delivery.payload.body, 80)}
        <span className="row__sub mono">{humanise(delivery.messageClass)}</span>
        {coalesced > 0 && (
          <span className="row__sub">covers {pluralise(coalesced, "reminder")}</span>
        )}
      </td>
      <td className="mono">{formatInstant(delivery.scheduledFor)}</td>
      <td className="mono">{formatInstant(delivery.deliveredAt)}</td>
      <td className={delivery.ackedAt === null ? "mono cell--error" : "mono"}>
        {delivery.ackedAt === null ? "never" : formatInstant(delivery.ackedAt)}
        {latency !== null && <span className="row__sub">after {formatDuration(latency)}</span>}
      </td>
      <td className="mono">
        {delivery.attempts}
        {delivery.nextAttemptAt !== null && (
          <span className="row__sub">next {formatInstant(delivery.nextAttemptAt)}</span>
        )}
      </td>
      <td className="table__prose">
        {delivery.lastError !== null && (
          <span className="cell--error">{firstLine(delivery.lastError, 80)}</span>
        )}
        <span className="row__sub">{describeEngagement(delivery)}</span>
        <span className="row__sub mono" title={delivery.idempotencyKey}>
          {delivery.channel} · {shortId(delivery.id)}
        </span>
      </td>
    </tr>
  );
}
