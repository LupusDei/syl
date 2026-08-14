import { systemClock, type Clock } from "../services/clock.js";
import { isId, newId } from "../services/id.js";
import type { AdjutantResult, InboundMessage, OutboundMessage, ReadOptions } from "./adjutant-client.js";
import type { AgentReply } from "./fencing.js";
import { replyContributor, type ReplyContribution } from "./reply-contributor.js";
import type { InboundReply, RepliesSeen } from "./replies-seen.js";

/**
 * THE RETURN LEG. How an answer finds its way back to her. `syl-j8fa.5`.
 *
 * `ask_agent` could speak and could not hear. She sent questions to the fleet
 * and, in her own words, had never received an answer: nothing routed a reply
 * back. Fixing delivery alone would have left her asking into a void she could
 * not see, which is a verb that is worse than not having one — she tells the
 * Commander she asked, and then nothing ever happens.
 *
 * ## She never waits
 *
 * Her turns are subprocess-bounded and an answer may take minutes or hours, so
 * blocking on one is not available and never will be. **The answer arrives on a
 * LATER turn.** Two moments, deliberately apart:
 *
 * - {@link AgentAnswers.collect} READS. It asks Adjutant what she has asked and
 *   what has been said back, matches the two, and stages what it found. It
 *   records nothing as shown and it never throws — it is background work on her
 *   turn path, and a throw here would reach the Commander as a turn that failed
 *   for a reason with nothing to do with what he said.
 * - {@link AgentAnswers.surface} SHOWS. It puts what is staged in front of her,
 *   labelled with the question each one answers, and records exactly that much
 *   as seen.
 *
 * **The cursor advances on SURFACE, never on READ**, and that sentence is the
 * whole correctness argument. Advancing on read swallows replies in silence —
 * the same failure class as the false confirmation this epic exists to fix, and
 * CLAUDE.md constraint 4 with a different noun. The ledger doing the advancing
 * is `agents/replies-seen.ts`, which derives its cursor rather than mutating a
 * watermark precisely so that reading cannot move it.
 *
 * ## Correlation: an id she can put in the TEXT
 *
 * The recipient answers **the ordinary way** — Adjutant `send_message` to her
 * name — and nothing is required of them. That is load-bearing rather than
 * polite: a protocol only she implements is a protocol nobody follows, and
 * every other agent in this fleet already replies with `send_message`.
 *
 * Which decides where the correlation id has to live. Adjutant injects the
 * message BODY into the recipient's session (`deliverDirectMessage`, whose
 * `deliveryText` defaults to the body), so a `threadId` they never see is one
 * they cannot echo. **The id therefore goes in the text**, as {@link refLine},
 * and it is *also* set as the thread id and in the metadata because those cost
 * nothing and are the certain carriers whenever a client does keep them.
 * {@link correlationIdsIn} looks in all three.
 *
 * ## The four matching rules, in priority order
 *
 * 1. **`threadId`** is one of her correlation ids. A client SET this; nothing
 *    guessed it.
 * 2. **`metadata`** carries one.
 * 3. **The body quotes one.** This is the rule that works today, and the reason
 *    the ref goes in the text at all: Adjutant injects `[DM from syl] <body>`
 *    into the recipient's session, so the ref line is in front of them verbatim
 *    and quoting it costs them nothing.
 * 4. **Nothing matched, but the sender owes her an answer.** The reply is filed
 *    against the most recent question she asked THAT AGENT before it arrived,
 *    and it is labelled `certain: false` — the fence then says, in as many
 *    words, that the agent did not say which question it answers.
 *
 * Rules 1-3 are facts. Rule 4 is a guess, and the whole point of keeping it a
 * separate field is that **a guess relayed as a certainty is a false
 * confirmation**, which is the exact defect `syl-j8fa` exists to fix. It also
 * never marks a question answered: she keeps waiting, because nothing has
 * actually told her the question was addressed.
 *
 * **Two questions outstanding to one agent at once** is the ambiguous case and
 * it is handled crudely and out loud: the reply is filed against the most
 * recent question asked before it arrived — a reply usually answers the last
 * thing said to it — and the count of the others is carried into the label, so
 * she is told there were N candidates rather than shown one pick as though it
 * were the only option.
 *
 * A DM from an agent she is NOT waiting on is not surfaced as an answer at all.
 * There is nothing to attach it to, and attaching an agent's good-morning to a
 * question about the Commander's money is worse than not showing it.
 *
 * ## The register is derived, not stored
 *
 * There is no table of outstanding questions here and no migration. `ask_agent`
 * runs in the tool subprocess, which has no database handle, so a local
 * register would need a route and a schema for something Adjutant already
 * holds — and holds in the same store the ANSWER will land in. What she asked
 * and what came back are one conversation; splitting them across two databases
 * is how they drift. {@link AdjutantClient.sent} reads it back.
 *
 * What is local is only "which answers has she already been shown", which is
 * the one fact Adjutant genuinely does not know.
 */

/** Adjutant's read side, as much of it as the return leg uses. */
export interface FleetReader {
  sent(options?: ReadOptions): Promise<AdjutantResult<readonly OutboundMessage[]>>;
  repliesFrom(
    who: string,
    options?: ReadOptions,
  ): Promise<AdjutantResult<readonly InboundMessage[]>>;
}

/**
 * How long an unanswered question stays outstanding: **seven days.**
 *
 * The bead left this open and asked for a number and the reasoning, so here is
 * both.
 *
 * **Seven days, because the shortest honest answer is "over a weekend".** These
 * agents run when the Commander is at his desk. A question put to an engineer
 * on Friday evening cannot expire before that engineer is next started, and a
 * window that does not span a weekend would routinely retire questions that
 * were about to be answered. Seven days is the smallest number that always
 * does. It is also short enough that "you are still waiting on this" stays a
 * true and useful sentence rather than a list of things he has forgotten
 * asking about.
 *
 * **What expiry does NOT do is drop anything, and that is the important half.**
 * It decides when she stops WAITING. It never decides when she stops HEARING:
 * matching is against the whole register Adjutant hands back, not against the
 * outstanding set, so an answer that took nine days is still recognised, still
 * labelled with the question, and still surfaced — it is simply no longer
 * something she is described as awaiting. Same instinct as CLAUDE.md
 * constraint 6: the system demotes, it does not delete. An unbounded list is
 * better than a silent drop, and this is neither.
 *
 * The only true bound on how far back a question can be recognised is
 * Adjutant's own read window — her newest 200 messages. She asks rarely, so
 * that is a long memory, and it is one number rather than two that must agree.
 */
export const QUESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * THE BOUND ON A CONVERSATION SHE DID NOT START. `syl-014.3.5`.
 *
 * A reply now reaches her turn, so a reply can cause a message, which causes a
 * reply. Two agents talking on the Commander's subscription is constraint 1,
 * and constraint 1 is the strongest one here.
 *
 * ## Why a window and not a hop count
 *
 * A hop count along the correlation chain is the obvious instrument and it was
 * the one asked for. It is the weaker of the two **in this system**, and the
 * reason is not a matter of taste:
 *
 * 1. **The chain can be broken by accident, and breaking it resets the bound
 *    to zero.** A hop count only counts while every question is recognisable as
 *    a continuation of the last. The model does not say "this is a follow-up";
 *    it calls the verb with a name and a question. So continuation has to be
 *    INFERRED — from a reply being in this turn's context — and the inference
 *    fails in the ordinary case where she waits a turn before asking, or asks
 *    in different words, or has two replies in front of her and only one chain
 *    can be the parent. Every one of those is a fresh chain at depth zero.
 * 2. **A ceiling on a chain is not a ceiling on cost.** Twenty chains of three
 *    is sixty messages, and each one is depth 1.
 * 3. **A window needs nothing from the model and nothing from inference.** It
 *    counts what actually left the machine. There is no chain to lose, no depth
 *    to reset, and no ambiguity about which chain a message belongs to.
 *
 * The two are the same instrument once you notice that what a hop count really
 * bounds is "how many times may this keep going before she has to go back to
 * him" — and a clock answers that without needing the chain to survive.
 *
 * ## What actually bounds the runaway, and it is not this
 *
 * **Her cadence.** Replies surface on her turns, and her unattended turns are
 * hourly, so a loop cannot run faster than one exchange an hour no matter what
 * this file says. The all-night machine-speed runaway is not available.
 *
 * Which tells you what this budget is really for: **the burst inside ONE
 * turn**, which is the case her cadence does not bound at all. One turn can
 * call the verb as many times as the model likes.
 */
export const ASK_BUDGET_WINDOW_MS = 60 * 60 * 1000;

/**
 * How many questions she may put to ONE agent inside {@link ASK_BUDGET_WINDOW_MS}.
 *
 * Three, and it is deliberately the number a hop ceiling would have used. Ask,
 * be told something that raises a follow-up, ask the follow-up — that is a
 * conversation working, and it is the exchange a stricter rule would have
 * destroyed. The fourth is where she stops and tells him instead.
 *
 * Per agent, because "she has asked the treasurer three times" says nothing
 * about whether raynor should hear from her, and a shared pool lets one busy
 * exchange silently mute every other one.
 */
export const MAX_QUESTIONS_PER_AGENT_PER_WINDOW = 3;

/**
 * How many questions she may put to the WHOLE fleet inside the same window.
 *
 * Six. The per-agent cap does not bound a burst that sprays the roster — five
 * agents at three each is fifteen messages out of a single turn — and this is
 * the number that does. Two agents fully consulted, or several asked once each,
 * inside an hour in which she gets roughly one unattended turn.
 */
export const MAX_QUESTIONS_PER_WINDOW = 6;

/**
 * How many questions she has already put to this agent inside the window.
 *
 * Counts QUESTIONS, not messages: only something carrying a correlation id is a
 * question. She is entitled to say thank you to an agent without it spending
 * the budget for things she is owed an answer to.
 *
 * @param who the recipient to count, or `null` for every recipient.
 */
export function questionsSentTo(
  who: string | null,
  sent: readonly OutboundMessage[],
  now: number,
): number {
  let count = 0;
  for (const message of sent) {
    if (who !== null && message.to !== who) continue;
    if (correlationIdsIn(message).length === 0) continue;

    const at = Date.parse(message.at);
    // An unreadable stamp COUNTS. The alternative is a message that spends
    // nothing because its timestamp was odd, which is a budget with a hole in
    // it that anything malformed falls through.
    if (Number.isNaN(at) || now - at <= ASK_BUDGET_WINDOW_MS) count += 1;
  }
  return count;
}

/**
 * Whether she has asked enough for now, and what she should say if she has.
 *
 * @returns `null` when she may ask, or a complete sentence explaining why she
 * did not. A sentence rather than a code, because the refusal IS the surfacing:
 * it is what she has instead of another message, and hitting a ceiling that
 * produced only a silent failure would look to her like a broken verb and to
 * him like nothing at all.
 */
export function askBudget(
  who: string,
  sent: readonly OutboundMessage[],
  now: number,
): string | null {
  if (questionsSentTo(who, sent, now) >= MAX_QUESTIONS_PER_AGENT_PER_WINDOW) {
    return (
      `I have already put ${String(MAX_QUESTIONS_PER_AGENT_PER_WINDOW)} questions to ${who} in ` +
      `the last hour and I would rather check with you than keep going on my own. I have not ` +
      `asked again — tell me if it is worth pressing, or what you want me to ask instead.`
    );
  }

  if (questionsSentTo(null, sent, now) >= MAX_QUESTIONS_PER_WINDOW) {
    return (
      `I have put ${String(MAX_QUESTIONS_PER_WINDOW)} questions to the others in the last hour, ` +
      `which is as far as I go without checking. I have not asked ${who} — tell me if this one ` +
      `matters more than waiting.`
    );
  }

  return null;
}

/**
 * The shape of a correlation id, and why it is an ordinary Syl id.
 *
 * A bare token would have done the matching. This buys three things a token
 * would not: it is self-describing in a log line and in the message itself; it
 * cannot collide with a reminder or goal id that an agent happened to quote
 * back at her, because the type segment is part of the match; and validation is
 * `isId(value, "agent_question")` rather than a second regex maintained here.
 */
const CORRELATION_ID =
  /syl:agent_question:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/gu;

/** Mint an id for a question she is about to ask. */
export function newCorrelationId(): string {
  return newId("agent_question");
}

/** Whether this is one of her correlation ids, and not some other id. */
export function isCorrelationId(value: string): boolean {
  return isId(value, "agent_question");
}

/**
 * The line appended to every question, and the only thing asked of anybody.
 *
 * Written to be quoted rather than parsed. The recipient is a model reading its
 * own session; it is told plainly what the line is for and what to do with it,
 * because "include this" with no reason is the sort of instruction a model
 * tidies away as boilerplate.
 */
export function refLine(correlationId: string): string {
  return (
    `[ref ${correlationId} — include this line in your reply so I can match your answer to ` +
    `this question. Reply the ordinary way, with send_message to syl.]`
  );
}

/** What she asked, as read back out of Adjutant. */
export interface AskedQuestion {
  readonly correlationId: string;
  /** The agent she put it to. */
  readonly who: string;
  /** Her words, with the ref line taken back off. */
  readonly question: string;
  /** When Adjutant recorded the question. An instant. */
  readonly askedAt: string;
}

/**
 * One answer, ready both to be shown and to be recorded.
 *
 * Assignable to {@link AgentReply} (what the fence renders) and to
 * {@link InboundReply} (what the ledger records) at once, so the object that
 * goes into her context is the same object that comes back out of
 * `replyContributor.kept` and goes straight into `RepliesSeen.record`. No
 * adapter in between, because an adapter there is a place for the message id to
 * change meaning — and the id is the unit of exactly-once.
 */
export interface AgentAnswer extends AgentReply, InboundReply {
  readonly correlationId: string;
}

export interface AgentAnswersOptions {
  readonly fleet: FleetReader;
  /** The exactly-once ledger. The cursor, derived. */
  readonly seen: RepliesSeen;
  readonly clock?: Clock;
  /** Where a failed poll is reported. Defaults to stderr. */
  readonly log?: (line: string, error?: unknown) => void;
}

/** Strip the ref line back off, leaving what she actually asked. */
function questionFrom(body: string): string {
  return body.replace(/\n*\[ref syl:agent_question:[^\]]*\]/gu, "").trim();
}

/**
 * Whether a question has stopped being one she is waiting on.
 *
 * An unparseable instant is treated as still live. It cannot be ordered, so the
 * only two options are "keep it" and "retire it on a stamp we could not read" —
 * and retiring on a stamp we could not read is a silent drop dressed up as
 * housekeeping.
 */
function lapsed(askedAt: string, now: number): boolean {
  const asked = Date.parse(askedAt);
  return Number.isNaN(asked) ? false : now - asked > QUESTION_TTL_MS;
}

/** Every correlation id carried by a message, on any of the three carriers. */
export function correlationIdsIn(message: {
  readonly body?: string;
  readonly threadId?: string;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}): readonly string[] {
  const found: string[] = [];
  const add = (value: string): void => {
    if (!found.includes(value)) found.push(value);
  };

  // The thread first: it is the carrier a client SET rather than one a model
  // happened to type, so when it is present it is the most trustworthy.
  if (message.threadId !== undefined && isCorrelationId(message.threadId)) add(message.threadId);

  // Serialised rather than walked. Metadata is arbitrary JSON an agent chose
  // the shape of, and a walker that only checked the fields we expected would
  // miss the one they actually used.
  if (message.metadata !== undefined) {
    for (const match of JSON.stringify(message.metadata).matchAll(CORRELATION_ID)) add(match[0]);
  }

  for (const match of (message.body ?? "").matchAll(CORRELATION_ID)) add(match[0]);

  return found;
}

export class AgentAnswers {
  readonly #fleet: FleetReader;
  readonly #seen: RepliesSeen;
  readonly #clock: Clock;
  readonly #log: (line: string, error?: unknown) => void;

  /**
   * What has been read and not yet shown, keyed by message id.
   *
   * **In memory on purpose, and nothing is at risk in it.** Adjutant is the
   * durable store for both halves — the question and the answer — so a restart
   * loses a cache and the next `collect` rebuilds it from the source. What must
   * survive a restart is "has she already been shown this", and that is the one
   * thing that is on disk.
   */
  readonly #staged = new Map<string, AgentAnswer>();

  /** The register as of the last successful read, oldest first. */
  #register: readonly AskedQuestion[] = [];

  /** Correlation ids something has come back on, whether or not she has seen it. */
  #answered = new Set<string>();

  /** The poll in flight, so a turn every minute cannot stack them up. */
  #collecting: Promise<number> | null = null;

  constructor(options: AgentAnswersOptions) {
    this.#fleet = options.fleet;
    this.#seen = options.seen;
    this.#clock = options.clock ?? systemClock;
    this.#log =
      options.log ??
      ((line, error) => {
        if (error === undefined) console.error(`[syl] ${line}`);
        else console.error(`[syl] ${line}`, error);
      });
  }

  /**
   * Read the fleet and stage anything that answers a question of hers.
   *
   * Never throws and never rejects. A failed read leaves everything already
   * staged exactly where it was: the alternative — clearing on failure — would
   * turn "Adjutant restarted" into "the treasurer's answer is gone", which is
   * the shape of defect this whole module is about.
   *
   * @returns how many answers were newly staged, which is what a log line wants.
   */
  async collect(): Promise<number> {
    try {
      return await this.#collect();
    } catch (error) {
      this.#log("failed to read the fleet for answers", error);
      return 0;
    }
  }

  /**
   * Collect, unless a collection is already running.
   *
   * The turn path fires this without awaiting it, on every turn. The hourly
   * heartbeat and a conversation can therefore overlap, and two polls against a
   * service on the same machine buy nothing over one.
   */
  refresh(): Promise<number> {
    const running = this.#collecting;
    if (running !== null) return running;

    const started = this.collect().finally(() => {
      this.#collecting = null;
    });
    this.#collecting = started;
    return started;
  }

  /** The questions she is still waiting on, oldest first. See {@link QUESTION_TTL_MS}. */
  outstanding(): readonly AskedQuestion[] {
    const now = this.#clock();
    // `#answered` holds only the CERTAIN matches. A reply that was merely filed
    // against a question by rule 4 does not retire it: nothing has actually
    // said the question was addressed, and marking it answered on a guess is
    // how she stops waiting for an answer that is still coming.
    return this.#register.filter(
      (question) => !this.#answered.has(question.correlationId) && !lapsed(question.askedAt, now),
    );
  }

  /**
   * The staged answers she has not been shown, oldest first.
   *
   * Filtered through the ledger on every call rather than trusted from staging,
   * because the ledger is the thing that survives a restart and staging is not.
   */
  pending(): readonly AgentAnswer[] {
    const staged = [...this.#staged.values()].sort(
      (a, b) => a.at.localeCompare(b.at) || a.messageId.localeCompare(b.messageId),
    );
    return this.#seen.unseen(staged);
  }

  /**
   * Put the answers she has not seen in front of her, and record exactly those.
   *
   * The ordering is the point. `replyContributor` decides what FITS and hands
   * back `kept`; only `kept` is recorded. Recording the whole batch would mark
   * an answer there was no room for as seen, and it would never arrive — the
   * omission note's promise that "nothing has been lost" turned into a lie, one
   * layer down from the bug this epic is about.
   *
   * A failed write still returns the contribution. Being shown an answer twice
   * is a nuisance; not being shown it is the thing that must not happen, and
   * `replies-seen.ts` settles that trade the same way.
   */
  surface(): ReplyContribution<AgentAnswer> | undefined {
    const contribution = replyContributor(this.pending());
    if (contribution === undefined) return undefined;

    try {
      this.#seen.record(contribution.kept);
      for (const answer of contribution.kept) this.#staged.delete(answer.messageId);
    } catch (error) {
      this.#log("failed to record which answers Syl has been shown", error);
    }

    return contribution;
  }

  async #collect(): Promise<number> {
    const register = await this.#fleet.sent();
    if (!register.ok) {
      this.#log(`could not read what Syl has asked: ${register.failure.message}`);
      return 0;
    }

    const questions = new Map<string, AskedQuestion>();
    for (const message of register.data) {
      // A message carrying no correlation id is not a question — it is her
      // talking to somebody, which she is entitled to do without it becoming a
      // thing she is owed an answer to.
      for (const correlationId of correlationIdsIn(message)) {
        if (questions.has(correlationId)) continue;
        questions.set(correlationId, {
          correlationId,
          who: message.to,
          question: questionFrom(message.body),
          askedAt: message.at,
        });
      }
    }

    this.#register = [...questions.values()].sort((a, b) => a.askedAt.localeCompare(b.askedAt));

    // Everyone she has ever asked within the read window, not merely everyone
    // with a live question. An answer to a question that lapsed last week is
    // still an answer, and not polling for it is exactly the silent drop
    // QUESTION_TTL_MS is careful not to be.
    const targets = [...new Set(this.#register.map((question) => question.who))];

    const now = this.#clock();
    const matched: AgentAnswer[] = [];
    const answered = new Set<string>();

    for (const who of targets) {
      const replies = await this.#fleet.repliesFrom(who);
      if (!replies.ok) {
        this.#log(`could not read what ${who} said: ${replies.failure.message}`);
        continue;
      }

      // TWO PASSES, and the order between them is what makes the result
      // independent of the order Adjutant happened to return rows in. The
      // fallback needs to know which questions are certainly answered, and a
      // single pass would know only about the replies it had already walked.
      const unmatched: InboundMessage[] = [];
      for (const reply of replies.data) {
        const correlationId = correlationIdsIn(reply).find((id) => questions.has(id));
        if (correlationId === undefined) {
          unmatched.push(reply);
          continue;
        }

        const question = questions.get(correlationId);
        if (question === undefined) continue;

        answered.add(correlationId);
        matched.push({
          messageId: reply.messageId,
          from: reply.from,
          body: reply.body,
          at: reply.at,
          correlationId,
          answering: {
            question: question.question,
            askedAt: question.askedAt,
            certain: true,
            alsoOutstanding: 0,
          },
        });
      }

      // Rule 4. Only questions this agent has NOT certainly answered, that were
      // asked before the reply arrived, and that have not lapsed.
      const owed = this.#register.filter(
        (question) =>
          question.who === who &&
          !answered.has(question.correlationId) &&
          !lapsed(question.askedAt, now),
      );

      for (const reply of unmatched) {
        const candidates = owed.filter((question) => question.askedAt <= reply.at);
        // The most recent question asked before it arrived. `owed` is oldest
        // first, so this is the last of them.
        const guess = candidates[candidates.length - 1];
        // Nothing to attach it to. An agent talking to her about something she
        // did not ask is a thing she is entitled to receive, and it is not this
        // module's business to present it as an answer.
        if (guess === undefined) continue;

        matched.push({
          messageId: reply.messageId,
          from: reply.from,
          body: reply.body,
          at: reply.at,
          correlationId: guess.correlationId,
          answering: {
            question: guess.question,
            askedAt: guess.askedAt,
            certain: false,
            alsoOutstanding: candidates.length - 1,
          },
        });
      }
    }

    // Whether she has SEEN an answer and whether one EXISTS are different
    // questions, and `outstanding` wants the second. Rebuilt from the whole
    // match rather than accumulated, so a question does not become outstanding
    // again the moment its answer is surfaced and dropped from staging.
    this.#answered = answered;

    const fresh = this.#seen.unseen(matched);
    const freshIds = new Set(fresh.map((answer) => answer.messageId));

    // Anything matched but already recorded is finished with. Dropping it here
    // rather than in `pending` keeps staging bounded by what is actually owed,
    // instead of by everything the fleet has ever said.
    for (const answer of matched) {
      if (!freshIds.has(answer.messageId)) this.#staged.delete(answer.messageId);
    }

    let added = 0;
    for (const answer of fresh) {
      if (this.#staged.has(answer.messageId)) continue;
      this.#staged.set(answer.messageId, answer);
      added += 1;
    }

    return added;
  }
}
