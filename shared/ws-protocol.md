# The Syl WebSocket protocol

`shared/schemas/ws.json` is the machine-readable form of everything below. It
is **generated** from `shared/openapi.yaml` — the `Ws*` schemas there are the
source of truth, and `npm run contract:generate` re-renders the bundle. This
document is the prose half: the parts of the protocol that are rules about
*sequencing and time* rather than about field shapes, which no schema can
express.

Endpoint: `GET /api/v1/ws`, upgraded. Same origin and same bearer token as the
REST API.

---

## 1. The frame catalogue

| Frame | Direction | Numbered | Replayed |
|---|---|---|---|
| `auth_challenge` | server → client | no | no |
| `auth_response` | client → server | no | — |
| `connected` | server → client | no | no |
| `chat_message` | client → server | no | — |
| `chat_message` | server → client | **yes** | **yes** |
| `delivery_confirmation` | server → client | **yes** | **yes** |
| `presence` | server → client | **no** | **never** |
| `sync` | client → server | no | — |
| `sync_response` | server → client | no | no |
| `ping` | client → server | no | — |
| `pong` | server → client | no | no |
| `error` | server → client | no | no |

`chat_message` is the one type that exists in both directions with different
shapes. The client's carries `clientId` and `idempotencyKey`; the server's
carries `seq`, `ts`, and a full `Message`. They are distinguished by direction,
not by name, because they are the same logical event seen from two ends.

Only the two rows marked **yes** in both columns enter the replay buffer.
Everything else is either a client frame, a handshake frame, or an answer to a
specific request — none of which mean anything out of their original context.

---

## 2. Two sequence spaces, and they are not the same number

This is the single easiest thing to get wrong, so it is stated first.

| | `message.seq` | frame `seq` |
|---|---|---|
| Scope | one conversation | one server's frame stream |
| Appears on | `Message.seq`, `DeliveryConfirmation.seq` (HTTP), `WsDeliveryConfirmation.messageSeq` | `WsServerChatMessage.seq`, `WsDeliveryConfirmation.seq`, `WsConnected.lastSeq`, `WsSync.sinceSeq` |
| Used for | ordering history inside a thread | detecting and recovering a gap on the socket |
| Resets | never, per conversation | never, per server lifetime |

A `delivery_confirmation` frame carries **both**: `seq` is its position in the
frame stream, `messageSeq` is the resulting message's position in its
conversation. Naming them apart is deliberate. Feed the wrong one to `sync` and
the client will either replay the whole stream or silently believe it is caught
up.

The HTTP `DeliveryConfirmation` body has only `seq`, and it is the **message**
sequence — there is no frame stream in an HTTP response to have a position in.
This is the one place the bare name `seq` means the message space. It is spelled
that way so a client that sent over HTTP because the socket was down reconciles
its optimistic row with exactly the same code path.

---

## 3. Connection lifecycle

```
client                                             server
  |  ---- HTTP GET /api/v1/ws (Upgrade) ------------->  |
  |  <--- auth_challenge {nonce, protocolVersion} ----  |
  |  ---- auth_response {token, nonce, lastSeq} ----->  |
  |  <--- connected {lastSeq, serverTime, principal} -  |
  |                                                     |
  |  <--- chat_message {seq: 41} ---------------------  |
  |  ---- ping {ts} --------------------------------->  |
  |  <--- pong {ts, serverTime} ---------------------   |
```

**The server speaks first.** `auth_challenge` arrives before the client sends
anything. A client that sends `auth_response` unprompted is answering a
challenge it has not seen, and the server closes on it.

Authentication is a frame, not a header, because the browser WebSocket API
cannot set one. The iOS client *could* use a header and deliberately does not:
one handshake, one code path, two platforms.

If the token is rejected, the server sends `error {fatal: true}` and closes.
`fatal` is what tells the client to stop reconnecting and re-pair rather than
loop against a wall.

### `protocolVersion`

An integer, currently `1`. It appears on both `auth_challenge` and `connected`
so a client learns it before committing to the session. A client that does not
recognise the version should refuse to interpret frames rather than guess — a
mobile app in the field will outlive several server deploys.

---

## 4. Gap recovery

The server keeps a bounded replay buffer of numbered frames. Every server frame
that is numbered is in it; nothing else is.

On reconnect:

1. The client sends its high-water mark as `auth_response.lastSeq`.
2. The server answers `connected` with the newest `seq` it holds.
3. If `connected.lastSeq > client's lastSeq`, there is a gap. The client sends
   `sync {sinceSeq}`.
4. The server answers `sync_response {fromSeq, toSeq, complete, frames}`.

**`complete: false` is the important case.** It means the requested range had
already fallen off the buffer — the client's gap is older than the server
remembers. The client must **not** treat itself as caught up. It falls back to
`GET /sync` and a history fetch. A phone that spent a weekend in a drawer takes
this path, and a client that ignores `complete` will silently miss everything
that aged out.

`frames` contains only `chat_message` and `delivery_confirmation`. It can never
contain `presence` — see below.

This machinery is why "the phone was in a tunnel" and "the Mac rebooted" are
non-events rather than lost messages. It is borrowed from Adjutant, where it
already works.

---

## 5. Presence — the deliberate exception

```json
{
  "type": "presence",
  "state": "speaking",
  "intensity": 0.4,
  "since": "2026-08-09T07:00:03.114Z",
  "ttl_ms": 4000
}
```

### It is never replayed. This is the rule the whole frame exists around.

Every other numbered frame replays on reconnect, and that is the point of the
replay buffer: a message the Commander missed is a message he should still get.

**Replaying `thinking` from four minutes ago is a lie.** It asserts something
about *now* that stopped being true while the socket was down. A character
frozen mid-thought is worse than no character at all, because it is actively
misrepresenting what the system is doing.

So: **messages replay, presence does not.**

### It carries no `seq`, and that follows from the same rule

Numbering presence would force one of two broken outcomes:

- the server replays it on `sync` — forbidden by the rule above; or
- the server skips it during replay, punching holes in the sequence space —
  and holes in the sequence space are precisely how gap detection works, so
  every reconnect would look like data loss.

Presence is out-of-band and unnumbered. A client that has missed presence
frames has missed nothing it should act on.

### It expires

`ttl_ms` is how long the state stays valid with no further frame. On expiry the
client falls back to `idle`, and after a further **30 seconds** of silence to
`absent`.

This is what stops a dropped connection from leaving Syl frozen mid-thought
forever. **The failure mode has to be quiet, not stuck.**

`absent` is the default state, not `idle` — she is not on screen unless
something put her there. During quiet hours it is `absent` unconditionally,
including for a reminder that was deferred to the morning.

### Unknown states are `idle`, not an error

`state` is an **open** enum. A client that receives a value it does not know
renders `idle` and carries on. This is so the service can add a state without
shipping an app update; a client that rejects the frame instead is a client that
breaks on a server deploy.

`intensity` is `0..1` and is **clamped client-side**. A server sending `1.4` is
wrong, but it must not break the app.

`since` is when the current **state** began — not when the frame was sent. It is
held constant across repeated frames of the same state, so a client that joins
mid-`speaking` can tell how long it has been going. Re-stamping it on every
frame would make it a duplicate of the send time and destroy the only
information it carries.

### There is no `GET /presence`

Deliberately. Any pull-based path hands the caller a state whose `ttl_ms` has
almost certainly already expired, which is exactly the lie the TTL rule exists
to prevent. Presence exists on the socket or not at all.

### `ttl_ms` is the one snake_case field on the wire

Everything else is camelCase. This field is quoted as literal JSON in the
character proposal and in `syl-001.2.2`; silently "fixing" the spelling is how a
contract stops matching the thing it was derived from. **Do not add a second
one.**

---

## 6. Sending a message, and the two ways it comes back

The client generates `clientId`, renders the bubble immediately as pending, and
sends — over the socket if it is up, over `POST /conversations/{id}/messages` if
it is not.

Reconciliation is by `clientId` in both cases:

- **socket** → `delivery_confirmation {clientId, serverId, messageSeq, ...}`
- **HTTP** → the `DeliveryConfirmation` body `{clientId, serverId, seq, ...}`

The client matches `clientId` against its pending row and swaps in `serverId`.

Without `clientId` there is no way to tell the server's copy of a message from a
new one, every retry looks like a fresh send, and the optimistic bubble either
duplicates or hangs pending forever. It is required on both paths.

`idempotencyKey` is separate from `clientId` and also required. `clientId`
identifies *this message* for reconciliation; `idempotencyKey` identifies *this
attempt* so a retried send is not a second message. The outbox retries by
design.

---

## 7. Keepalive

Application-level `ping`/`pong`, above any transport-level ping frame, because
intermediaries terminate and forge those and the client learns nothing.

The client pings every **30 seconds** and treats **two** missed pongs as a dead
socket. Reconnect uses exponential backoff with jitter, capped at 30 seconds.

This matters more than it looks under Tailscale: the iOS network extension is
torn down when idle, so the first attempt after a wake can fail while the tunnel
re-establishes. Treating that as "server down" makes a working system feel
broken. Every reconnect retries.

---

## 8. `sync` the frame is not `/sync` the endpoint

| | `WsSync` frame | `GET /sync` |
|---|---|---|
| Parameter | `sinceSeq` (integer) | `since` (opaque cursor) |
| Recovers | frames dropped on this socket | the whole device store |
| Scope | the frame stream | every resource type |
| Survives | one reconnect | reinstall, days offline |

The parameter names differ **so that no one can conflate them**. A device whose
socket dropped in a tunnel uses the frame. A device that has been offline for a
week uses the endpoint. They are not interchangeable and neither is a
substitute for the other.

---

## 9. Errors

`error` carries the same `ApiError` as every HTTP response, so one error
renderer serves both transports. It was not in the original frame list and was
added because without it every squad invents its own shape for "your token
expired" and they disagree.

`fatal: true` means the server is about to close the socket and the client
should stop reconnecting until something changes — a re-pair, a new token, a
version bump. `fatal: false` is informational; the socket stays up.
