-- 0005_outbox.sql — the delivery outbox. This table IS the guarantee.
--
-- APNs cannot tell us whether a notification arrived. Apple returns an
-- `apns-unique-id` per request, and it is lookup-only in a web console: there
-- is no public query endpoint. Worse, while a device is offline Apple retains
-- only the MOST RECENT notification per app, so a night of reminders collapses
-- into one.
--
-- Therefore push is a notification, not the delivery mechanism. What makes a
-- reminder undroppable is this row: it exists before the push is attempted, it
-- survives a failed attempt, a reboot, and a week of the phone being off, and
-- it is marked delivered only when the device itself says so.
--
--   delivered_at  APNs accepted the request. Not a delivery.
--   acked_at      The device confirmed. THIS is delivery.

CREATE TABLE deliveries (
  id              TEXT    NOT NULL PRIMARY KEY,
  channel         TEXT    NOT NULL CHECK (channel IN ('apns', 'adjutant', 'websocket')),

  -- What kind of proactive message this is, for the interruption ledger.
  -- Matches JobKind for job-originated deliveries.
  message_class   TEXT    NOT NULL,

  reminder_id     TEXT,

  -- The whole notification, self-sufficient. The reminder text goes in the
  -- body, never an id to fetch: push reaches the phone over Apple's network,
  -- which does not touch the tailnet, so a notification must still be readable
  -- when the tunnel is down and nothing can be fetched.
  payload_json    TEXT    NOT NULL,

  -- UNIQUE, and that is the point. A delivery job that runs twice — a retry, a
  -- recovery pass after a reboot, two ticks racing — writes one row. Syl never
  -- says the same thing twice.
  idempotency_key TEXT    NOT NULL UNIQUE,

  state           TEXT    NOT NULL CHECK (
                    state IN ('pending', 'sending', 'delivered', 'acknowledged', 'failed', 'abandoned')
                  ),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),

  -- Null means "not scheduled to be attempted": either it is in flight, or it
  -- has reached a terminal state. This column is also where quiet hours land —
  -- the gate is on the OUTBOX, not on the scheduler, so consolidation can run
  -- at 02:30 at full effort while saying nothing.
  next_attempt_at TEXT,

  delivered_at    TEXT,
  acked_at        TEXT,
  engagement      TEXT CHECK (
                    engagement IS NULL
                    OR engagement IN ('delivered', 'opened', 'acted_on', 'dismissed', 'ignored')
                  ),

  -- Fired after `scheduled_for` because the machine was down. A late reminder
  -- says it is late; it is never silently dropped and never pretends to be on
  -- time.
  late            INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0, 1)),
  scheduled_for   TEXT,

  -- A JSON array, non-empty when this row is the single "here is what waited
  -- overnight" notification for a batch deferred past quiet hours. Deferral
  -- moves everything in the window to the same instant, so ten reminders would
  -- otherwise arrive as ten notifications in one second — correct by the letter
  -- of the guarantee and awful in practice.
  coalesced_ids   TEXT    NOT NULL DEFAULT '[]',

  apns_unique_id  TEXT,
  last_error      TEXT,
  created_at      TEXT    NOT NULL
) STRICT;

-- The question the sender asks on every tick: what is due to be attempted?
CREATE INDEX deliveries_due_idx ON deliveries (state, next_attempt_at);

-- The interesting admin view: what was sent and never acknowledged.
CREATE INDEX deliveries_unacked_idx ON deliveries (acked_at, created_at DESC);

-- Everything belonging to one reminder, for the app's reconcile.
CREATE INDEX deliveries_reminder_idx ON deliveries (reminder_id, created_at DESC);
