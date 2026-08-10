import type { ReactElement } from "react";

import { Badge } from "../../ui/Badge";
import { alarmPresentation, type InvariantAlarm } from "./memory-model";

/**
 * The zero invariant, where he cannot miss it.
 *
 * ## Why this is the first thing on the page
 *
 * `metrics.ts` calls it "the single most important number in the whole
 * observability surface", and it is the one that distinguishes *nothing deserved
 * reactivation* from *reactivation is broken* — otherwise identical from
 * outside. A panel that buries it has failed at the one job it had, so it is
 * rendered above the graph, above the toolbar, and it is never collapsible when
 * it has something to say.
 *
 * ## `rejected_connection_resurrected` is not a louder `critical`
 *
 * It has its own field in the payload, its own predicate (`isTrustFailure`), and
 * here its own word: **TRUST FAILURE**. It means reflection tried to bring back
 * a connection the Commander explicitly rejected. Folding it into a generic
 * error count — "3 problems" — would destroy the distinction the backend went to
 * some trouble to keep, and the distinction is the whole point: one says the
 * machinery is wrong, the other says we broke a promise to him.
 *
 * ## `unproven` gets a chip, not a tick
 *
 * Zero breaches out of zero insertion attempts is an absence of evidence. It is
 * drawn in the pending tone with the word UNPROVEN, never in green and never
 * with a tick, because those would say "checked, fine" about a check that has
 * never run.
 */

export interface AlarmBannerProps {
  readonly alarm: InvariantAlarm;
}

export function AlarmBanner({ alarm }: AlarmBannerProps): ReactElement {
  const presentation = alarmPresentation(alarm);
  return (
    <div
      className={presentation.broken ? "notice notice--fail" : "notice"}
      // Only a real breach shouts at a screen reader. `unproven` is a standing
      // condition, not an event, and an alert that fires on every page load for
      // a state that will hold for weeks is an alert that gets ignored.
      {...(presentation.broken ? { role: "alert" as const } : {})}
      data-testid="invariant-alarm"
      data-status={alarm.status}
      data-trust-failure={String(presentation.trustFailure)}
    >
      <div className="notice__head">
        <Badge tone={presentation.tone} title={alarm.status}>
          {presentation.label}
        </Badge>
        <strong>The zero invariant</strong>
      </div>
      <p className="notice__body">{alarm.headline}</p>
      <p className="notice__body">{presentation.guidance}</p>
      <p className="notice__meta mono">
        {alarm.total} breach(es) · {alarm.byExistingTier.suppressed} against a REJECTED edge ·{" "}
        {alarm.byExistingTier.cold} against a dormant one · {alarm.byExistingTier.hot} against a
        live one · {alarm.insertionsAttempted} insertion(s) ever attempted
      </p>
    </div>
  );
}
