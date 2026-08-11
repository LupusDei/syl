/**
 * The agents Syl may speak to, and what each one is for.
 *
 * A named list rather than "whoever Adjutant knows about", for the same reason
 * `AGENT_SURFACE` names the routes she may reach: **adding an entry is a
 * decision about who can influence her, not a convenience.** The roster she
 * could otherwise see is every agent on the machine, including ones spawned by
 * work that has nothing to do with the Commander.
 *
 * ## What she is doing here, and what she is not
 *
 * She **asks**. She does not coordinate. The Commander was explicit —
 * *"Not trying to get her to coordinate the swarm"* — and the distinction is
 * load-bearing rather than a matter of taste: an assistant bonded to one person
 * who also runs a fleet is two different things, and the second one drowns the
 * first. Nothing here reports status, claims work, or answers to anyone.
 *
 * ## Why every reply is untrusted
 *
 * An answer is text she did not write, arriving in the lane that runs
 * pre-authorised with her full tool surface. That is exactly what the sealed
 * reader exists to prevent — and it is worse than a fetched article, because an
 * agent's answer is *plausible*: it is about his life, in the right register,
 * from a source he trusts. An agent that had itself read something hostile
 * would pass it straight through.
 *
 * So a reply is DATA. It is fenced before she sees it, it never carries
 * instructions she may follow, and her precedence ladder already ranks it last:
 * a thing she read is not a thing she knows about him, and she says where it
 * came from.
 */

/** One agent she may speak to. */
export interface RosterEntry {
  /** The id Adjutant knows them by. */
  readonly id: string;
  /** What she can honestly expect from them, in her own terms. */
  readonly good_for: string;
}

/**
 * Who she may reach.
 *
 * Deliberately short. Each entry is someone the Commander named, and the
 * `good_for` line is what she is told about them — so she asks the right one
 * rather than broadcasting, which is the behaviour that turns a useful verb
 * into a fleet she is running.
 */
export const ROSTER: readonly RosterEntry[] = [
  {
    id: "treasurer",
    good_for:
      "his money: accounts, bills, what things cost",
  },
  {
    id: "artanis",
    good_for: "how Syl herself is built",
  },
  {
    id: "tassadar",
    good_for: "how Syl herself is built",
  },
  {
    id: "raynor",
    good_for: "building software",
  },
  {
    id: "adjutant-coordinator",
    good_for: "who is working on what",
  },
];

/** Whether she may speak to this agent at all. */
export function mayReach(id: string): boolean {
  return ROSTER.some((entry) => entry.id === id);
}

/**
 * The refusal she gets for an agent not on the list.
 *
 * Names who she CAN reach, the way the agent-scope refusal does, because she
 * has to turn it into a sentence for him — "I can't ask them, but I could ask
 * the treasurer" is an answer and "forbidden" is a shrug.
 */
export function notOnTheRoster(id: string): string {
  const names = ROSTER.map((entry) => entry.id).join(", ");
  return `I cannot reach ${id}. The ones I can ask are: ${names}.`;
}
