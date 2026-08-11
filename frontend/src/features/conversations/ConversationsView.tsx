import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useNavigate, useParams } from "react-router-dom";

import type { ConversationLane, ConversationPage, MessagePage } from "@syl/shared/types";

import { useAdminClient } from "../../api/use-admin-client";
import { useResource, type Loader } from "../../api/use-resource";
import { formatInstant } from "../../format/time";
import { humanise, shortId } from "../../format/text";
import { Badge } from "../../ui/Badge";
import { Empty, ErrorNotice, Loading } from "../../ui/feedback";
import {
  asTranscript,
  CONVERSATION_LANES,
  conversationTitle,
  filterMessages,
  hasSequenceGap,
  laneTone,
  roleTone,
  sortConversations,
} from "./conversation-model";

/**
 * The lanes and their transcripts.
 *
 * `interactive` is the Commander's own thread; `job` lanes hold background
 * work, and they are separate so Syl's inner monologue never interleaves with
 * talking to him. This view keeps them separate for the same reason.
 */
export function ConversationsView(): ReactElement {
  const client = useAdminClient();
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const [lane, setLane] = useState<ConversationLane | "">("");
  const [query, setQuery] = useState("");

  const loadLanes = useCallback<Loader<ConversationPage>>(
    (signal) => {
      if (client === null) return Promise.reject(new Error("signed out"));
      return client.listConversations(lane === "" ? {} : { lane }, { signal });
    },
    [client, lane],
  );
  const lanes = useResource<ConversationPage>(client === null ? null : loadLanes);

  const selectedId = conversationId ?? null;
  const loadMessages = useCallback<Loader<MessagePage>>(
    (signal) => {
      if (client === null || selectedId === null) return Promise.reject(new Error("no lane"));
      return client.listMessages(selectedId, { limit: 100 }, { signal });
    },
    [client, selectedId],
  );
  const messages = useResource<MessagePage>(
    client === null || selectedId === null ? null : loadMessages,
  );

  const rows = useMemo(() => sortConversations(lanes.data?.items ?? []), [lanes.data]);
  const selected = rows.find((conversation) => conversation.id === selectedId) ?? null;
  const loaded = messages.data?.items ?? [];
  const transcript = useMemo(() => asTranscript(filterMessages(loaded, query)), [loaded, query]);

  return (
    <section className="view view--wide">
      <h1 className="view__title">Conversations</h1>
      <p className="view__lede">
        One <code>interactive</code> lane — the Commander&rsquo;s own thread — and a{" "}
        <code>job</code> lane per background run. They are separate on the wire so Syl&rsquo;s inner
        monologue never interleaves with talking to him, and they stay separate here.
      </p>

      <div className="toolbar">
        <label className="field field--inline">
          Lane
          <select
            className="field__select"
            value={lane}
            onChange={(event) => {
              setLane(event.target.value as ConversationLane | "");
            }}
          >
            <option value="">any</option>
            {CONVERSATION_LANES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button className="button" type="button" onClick={lanes.reload} disabled={lanes.loading}>
          {lanes.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {lanes.error !== null && <ErrorNotice error={lanes.error} onRetry={lanes.reload} />}
      {lanes.error === null && lanes.loading && lanes.data === null && (
        <Loading label="Loading lanes…" />
      )}
      {lanes.error === null && lanes.data !== null && rows.length === 0 && (
        <Empty>No conversation lane matches this filter.</Empty>
      )}

      {rows.length > 0 && (
        <table className="table table--dense">
          <caption className="table__caption">Lanes</caption>
          <thead>
            <tr>
              <th scope="col">Lane</th>
              <th scope="col">Title</th>
              <th scope="col">Messages</th>
              <th scope="col">Last message</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((conversation) => (
              <tr
                key={conversation.id}
                className={conversation.id === selectedId ? "row row--selected" : "row"}
              >
                <th scope="row">
                  <Badge tone={laneTone(conversation.lane)} title={conversation.id}>
                    {conversation.lane}
                  </Badge>
                </th>
                <td>
                  <button
                    className="link"
                    type="button"
                    onClick={() => {
                      navigate(
                        conversation.id === selectedId
                          ? "/conversations"
                          : `/conversations/${encodeURIComponent(conversation.id)}`,
                      );
                    }}
                  >
                    {conversationTitle(conversation)}
                  </button>
                  <span className="row__sub mono">{shortId(conversation.id)}</span>
                </td>
                <td className="mono">{conversation.messageCount}</td>
                <td className="mono">{formatInstant(conversation.lastMessageAt)}</td>
                <td className="mono">{formatInstant(conversation.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedId !== null && (
        <section className="detail">
          <div className="detail__head">
            <h2 className="detail__title">
              {selected === null ? "Transcript" : conversationTitle(selected)}{" "}
              <span className="mono detail__id" title={selectedId}>
                {shortId(selectedId)}
              </span>
            </h2>
            <label className="field field--inline">
              Search
              <input
                className="field__select"
                type="search"
                value={query}
                placeholder="filter loaded messages"
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </label>
            <button
              className="button"
              type="button"
              onClick={messages.reload}
              disabled={messages.loading}
            >
              {messages.loading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => {
                navigate("/conversations");
              }}
            >
              Close
            </button>
          </div>

          {/* Honesty about the search: the contract has no message search, so
              this filters what has been fetched. A box that silently covered
              only the last hundred messages would be worse than none. */}
          <p className="detail__note">
            Search filters the {loaded.length} messages loaded here. There is no server-side message
            search in the contract.
            {hasSequenceGap(loaded) && " Sequence numbers are not contiguous — this page has gaps."}
          </p>

          {messages.error !== null && <ErrorNotice error={messages.error} onRetry={messages.reload} />}
          {messages.error === null && messages.loading && messages.data === null && (
            <Loading label="Loading transcript…" />
          )}
          {messages.error === null && messages.data !== null && transcript.length === 0 && (
            <Empty>{loaded.length === 0 ? "No messages in this lane." : "Nothing matches."}</Empty>
          )}

          {transcript.length > 0 && (
            <table className="table table--dense">
              <caption className="table__caption">Transcript</caption>
              <thead>
                <tr>
                  <th scope="col">Seq</th>
                  <th scope="col">Role</th>
                  <th scope="col">At</th>
                  <th scope="col">Text</th>
                </tr>
              </thead>
              <tbody>
                {transcript.map((message) => (
                  <tr key={message.id} className="row">
                    <th scope="row" className="mono">
                      {message.seq}
                    </th>
                    <td>
                      <Badge tone={roleTone(message.role)} title={message.id}>
                        {humanise(message.role)}
                      </Badge>
                    </td>
                    <td className="mono">{formatInstant(message.createdAt)}</td>
                    <td className="table__prose cell--wrap">
                      {message.text}
                      {message.clientId !== null && (
                        <span className="row__sub mono" title="clientId — what an optimistic send reconciles by">
                          {message.clientId}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </section>
  );
}
