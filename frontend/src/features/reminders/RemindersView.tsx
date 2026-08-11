import { useCallback, useMemo, useState, type ReactElement } from "react";

import type { Reminder, ReminderDeliveryState, ReminderPage } from "@syl/shared/types";

import { useAdminClient } from "../../api/use-admin-client";
import { useResource, type Loader } from "../../api/use-resource";
import { formatInstant } from "../../format/time";
import { humanise, shortId } from "../../format/text";
import { Badge } from "../../ui/Badge";
import { Empty, ErrorNotice, Loading } from "../../ui/feedback";
import {
  provenanceLabel,
  provenanceOf,
  provenanceTone,
  reasonOf,
  sortReminders,
  summariseProvenance,
  summaryHeadline,
} from "./reminder-model";

/**
 * Every reminder, and why it exists.
 *
 * `syl-y82`. The design brief is one sentence: **a list he can scan and think
 * "she thought of these four"**. `SOUL.md` promises him that if he ignores a
 * kind of suggestion again and again he can tell her to stop making it — and
 * that was impossible, because nothing anywhere showed which reminders were
 * hers. The "Syl noticed" filter below is the whole feature; the rest is
 * context around it.
 *
 * Read-only, like every other view here. Reminder text is composed at creation
 * time in her voice and delivery reads it verbatim, so a console that could
 * edit it would be a second author of the one string nothing downstream can
 * improve.
 */
export function RemindersView(): ReactElement {
  const client = useAdminClient();
  const [state, setState] = useState<ReminderDeliveryState | "">("");
  const [hersOnly, setHersOnly] = useState(false);

  const load = useCallback<Loader<ReminderPage>>(
    (signal) => {
      if (client === null) return Promise.reject(new Error("signed out"));
      return client.listReminders(state === "" ? {} : { state }, { signal });
    },
    [client, state],
  );
  const reminders = useResource<ReminderPage>(client === null ? null : load);

  const items = reminders.data?.items ?? [];
  // The summary counts the whole page, never the filtered view: the number he
  // is here for is "how many of these did she think of", and a count that
  // changed when he ticked the filter would be answering a different question.
  const summary = useMemo(() => summariseProvenance(items), [items]);
  const rows = useMemo(() => {
    const sorted = sortReminders(items);
    return hersOnly ? sorted.filter((r) => provenanceOf(r) === "hers") : sorted;
  }, [items, hersOnly]);

  return (
    <section className="view view--wide">
      <h1 className="view__title">Reminders</h1>
      <p className="view__lede">
        What she has been offering unprompted, and why. <code>origin</code> is derived where it can
        be — a turn with no message from him cannot be answering one — so &ldquo;Syl noticed&rdquo;
        is a fact about that turn rather than a claim she makes about herself.
      </p>

      {reminders.data !== null && (
        <div className="banner" data-testid="provenance-summary">
          <Badge tone={summary.hers > 0 ? "accent" : "muted"}>{summaryHeadline(summary)}</Badge>
        </div>
      )}

      <div className="toolbar">
        <label className="field">
          <input
            type="checkbox"
            checked={hersOnly}
            onChange={(event) => {
              setHersOnly(event.target.checked);
            }}
          />
          Only the ones Syl thought of
        </label>

        <label className="field">
          State
          <select
            className="field__select"
            value={state}
            onChange={(event) => {
              setState(event.target.value as ReminderDeliveryState | "");
            }}
          >
            <option value="">any</option>
            {REMINDER_STATES.map((option) => (
              <option key={option} value={option}>
                {humanise(option)}
              </option>
            ))}
          </select>
        </label>

        <button
          className="button"
          type="button"
          onClick={reminders.reload}
          disabled={reminders.loading}
        >
          {reminders.loading ? "Refreshing…" : "Refresh"}
        </button>

        <span className="toolbar__count">
          {hersOnly ? "showing only what Syl thought of" : "showing every reminder"}
          {state === "" ? "" : `, state ${humanise(state)}`}
        </span>
      </div>

      {reminders.error !== null && <ErrorNotice error={reminders.error} onRetry={reminders.reload} />}
      {reminders.error === null && reminders.loading && reminders.data === null && (
        <Loading label="Loading reminders…" />
      )}
      {reminders.error === null && reminders.data !== null && rows.length === 0 && (
        <Empty>
          {hersOnly
            ? "Syl has not offered any of these unprompted. Clear the filter to see them all."
            : "No reminder matches this filter. Nothing is being hidden — the server returned none."}
        </Empty>
      )}

      {rows.length > 0 && (
        <table className="table table--dense">
          <caption className="table__caption">Reminders</caption>
          <thead>
            <tr>
              <th scope="col">Origin</th>
              <th scope="col">Reminder</th>
              <th scope="col">Why</th>
              <th scope="col">State</th>
              <th scope="col">Next due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((reminder) => (
              <ReminderRow key={reminder.id} reminder={reminder} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Exhaustive by construction: a state added to the contract fails typecheck
 * here rather than quietly dropping out of the filter.
 */
const REMINDER_STATE_SET: Record<ReminderDeliveryState, true> = {
  scheduled: true,
  due: true,
  delivered: true,
  acknowledged: true,
  deferred: true,
  completed: true,
  cancelled: true,
  failed: true,
};

// Safe: the keys of an exhaustive `Record<ReminderDeliveryState, …>`.
const REMINDER_STATES = Object.keys(REMINDER_STATE_SET) as readonly ReminderDeliveryState[];

function ReminderRow({ reminder }: { reminder: Reminder }): ReactElement {
  const provenance = provenanceOf(reminder);
  const reason = reasonOf(reminder);

  return (
    <tr className="row" data-testid="reminder-row" data-provenance={provenance}>
      <th scope="row">
        <Badge tone={provenanceTone(provenance)} title={reminder.origin ?? "not recorded"}>
          {provenanceLabel(provenance)}
        </Badge>
      </th>
      <td className="table__prose">
        {reminder.text}
        <span className="row__sub mono">
          {humanise(reminder.kind)} · {shortId(reminder.id)}
        </span>
      </td>
      <td className="table__prose">
        {reason === null ? (
          /*
           * `syl-91z`, restated for one cell: "nothing to show" and "failed to
           * show" must never look alike — and there is a third thing here that
           * must look like neither.
           *
           * A null `because` is not Syl declining to explain herself. The
           * handler refuses a `remind_me` call without one, so a null can only
           * be a row written before the column existed, and nothing was
           * backfilled because a guessed reason is the exact
           * claim-beyond-the-evidence the field exists to prevent.
           *
           * So this says what is true about the RECORD and styles it as
           * unremarkable: `row__sub` is the same quiet class every secondary
           * line uses, not `cell--error`, which is what a genuine failure gets
           * two columns over. A dash would be ambiguous with a rendering bug;
           * "no reason given" would be a lie about her.
           */
          <span className="row__sub" data-testid="reason-unrecorded">
            recorded before Syl kept her reasons
          </span>
        ) : (
          reason
        )}
      </td>
      <td>
        <Badge tone="muted" title={reminder.deliveryState}>
          {humanise(reminder.deliveryState)}
        </Badge>
        {reminder.late && <span className="row__sub cell--late">late</span>}
      </td>
      <td className="mono">
        {formatInstant(reminder.nextFireAt)}
        <span className="row__sub">
          {reminder.wallTime} {reminder.tz}
        </span>
      </td>
    </tr>
  );
}
