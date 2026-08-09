/**
 * What the conversation viewer decides, as pure functions.
 *
 * The lane split is the thing to get right. `interactive` is the Commander's
 * own durable thread; `job` lanes hold background work — a research run, the
 * nightly consolidation, the heartbeat — and they are separated precisely so
 * Syl's inner monologue never interleaves with talking to him. A viewer that
 * mixed them would undo the reason the lanes exist.
 */

import type { Conversation, ConversationLane, Message, MessageRole } from "@syl/shared/types";

import type { Tone } from "../../ui/Badge";

export const CONVERSATION_LANES: readonly ConversationLane[] = ["interactive", "job"];

export function laneTone(lane: ConversationLane): Tone {
  return lane === "interactive" ? "accent" : "muted";
}

/** The Commander's thread has no title; saying so beats an empty cell. */
export function conversationTitle(conversation: Conversation): string {
  if (conversation.title !== null && conversation.title.length > 0) return conversation.title;
  return conversation.lane === "interactive" ? "The Commander's thread" : "Untitled job lane";
}

/**
 * Interactive first, then job lanes by most recent activity.
 *
 * The Commander's own thread is the one you almost always want, and a
 * research run from last night should not push it below the fold.
 */
export function sortConversations(items: readonly Conversation[]): Conversation[] {
  return [...items].sort((a, b) => {
    if (a.lane !== b.lane) return a.lane === "interactive" ? -1 : 1;
    const at = a.lastMessageAt ?? a.updatedAt;
    const bt = b.lastMessageAt ?? b.updatedAt;
    return bt.localeCompare(at);
  });
}

export function roleTone(role: MessageRole): Tone {
  switch (role) {
    case "user":
      return "accent";
    case "assistant":
      return "ok";
    default:
      return "muted";
  }
}

/**
 * Search, over the page that is loaded.
 *
 * **The contract has no message search.** `GET /conversations/{id}/messages`
 * takes a cursor, a limit and a direction and nothing else, so this filters
 * what has been fetched rather than pretending to ask the server. The viewer
 * says so on screen; a search box that silently only covers the last fifty
 * messages is worse than no search box.
 */
export function matchesQuery(message: Message, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    message.text.toLowerCase().includes(needle) ||
    message.role.includes(needle) ||
    message.id.toLowerCase().includes(needle)
  );
}

export function filterMessages(items: readonly Message[], query: string): Message[] {
  return items.filter((message) => matchesQuery(message, query));
}

/**
 * Messages come back newest-first from the default `backward` direction. A
 * transcript reads oldest-first, so it is reversed here rather than by asking
 * for `forward` — `forward` walks toward the present from a cursor, which is
 * a different question.
 */
export function asTranscript(items: readonly Message[]): Message[] {
  return [...items].sort((a, b) => a.seq - b.seq);
}

/** A gap in `seq` means the page does not hold every message in the range. */
export function hasSequenceGap(items: readonly Message[]): boolean {
  const ordered = asTranscript(items);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) continue;
    if (current.seq !== previous.seq + 1) return true;
  }
  return false;
}
