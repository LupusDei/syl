/**
 * The section list, as data.
 *
 * One array drives both the sidebar and the route table, so a section cannot
 * exist in the nav without a route or the other way round. Each planned entry
 * names the bead that will fill it — the shell is honest about being a shell,
 * and the placeholder tells the next agent exactly which bead they are on.
 */

export type NavStatus = "ready" | "planned";

export interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly summary: string;
  /** The bead that owns this view. */
  readonly bead: string;
  readonly status: NavStatus;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    path: "/",
    label: "Overview",
    summary: "What this surface is, what it is connected to, and what is not built yet.",
    bead: "syl-004.1.1",
    status: "ready",
  },
  {
    path: "/jobs",
    label: "Jobs and runs",
    summary: "Every job run with outcome, duration and failure detail — including overnight work.",
    bead: "syl-004.2.1",
    status: "planned",
  },
  {
    path: "/delivery",
    label: "Delivery outbox",
    summary: "What was sent, what was retried, and what is still unconfirmed.",
    bead: "syl-004.2.2",
    status: "planned",
  },
  {
    path: "/conversations",
    label: "Conversations",
    summary: "Turn-by-turn transcripts per lane, with the session id behind each one.",
    bead: "syl-004.2.3",
    status: "planned",
  },
  {
    path: "/devices",
    label: "Devices",
    summary: "Registered push targets and when each last acknowledged anything.",
    bead: "syl-004.2.3",
    status: "planned",
  },
];
