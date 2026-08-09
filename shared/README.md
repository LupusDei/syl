# `@syl/shared` — the API contract

The single source of truth for every wire type in Syl. Three codebases are
measured against it: `backend/`, `frontend/`, and `ios/SylKit`.

```
openapi.yaml       THE CONTRACT. Hand-authored. Everything else derives from it.
ws-protocol.md     The WebSocket rules a schema cannot express.
schemas/ws.json    GENERATED — JSON Schema bundle of the frames.
src/types.ts       GENERATED — TypeScript types.
fixtures/          The shared fixtures, indexed by manifest.json.
src/mock/          The mock server.
```

Regenerate with `npm run contract:generate`. **`npm test` fails if a generated
file has drifted from the spec**, so a spec change that was not regenerated
cannot reach a squad.

## Start here: `npm run mock`

```sh
npm run mock                          # http://127.0.0.1:4210/api/v1
npm run mock -- --port 4300 --latency 250 --jitter 100
```

It serves **every operation in the contract** — the route table is derived from
`openapi.yaml`, and a test cross-checks it against the handler map, so an
endpoint cannot exist in the spec and quietly 404 here.

Two behaviours matter more than the rest:

- **Writes echo your own ids.** Send a message with your `clientId` and the
  confirmation comes back carrying it. A mock that returned a canned id would
  make optimistic reconciliation look broken in the one place it is hardest to
  debug.
- **Writes change what later reads return**, and feed `GET /sync`. The
  local-first flow — push outbox → pull since cursor → reconcile → ack — is
  testable end to end.

`Idempotency-Key` is **required on every write**, and it works: the same key
with the same body replays the stored response with `Idempotency-Replayed:
true`; the same key with a different body is a `409 IDEMPOTENCY_KEY_REUSE`.

### Scripting failure

A happy-path mock produces clients that fall over the first time reality is
slow. Reality here is a Mac at home behind a tunnel that is torn down when
idle, so the first request after a wake genuinely does fail.

None of the control endpoints are themselves delayed or faulted — otherwise you
could not switch a fault off once it was on.

```sh
B=http://127.0.0.1:4210

# Fail the next three calls, then recover.
curl -X POST $B/__mock/scenario -d '{"failNext":3,"error":"UPSTREAM_UNAVAILABLE","status":503}'

# 20% of calls fail, reproducibly — the RNG is seeded.
curl -X POST $B/__mock/scenario -d '{"errorRate":0.2,"seed":7}'

# The tunnel is not there. Not an error response: no response at all.
curl -X POST $B/__mock/scenario -d '{"offline":true}'

curl -X DELETE $B/__mock/scenario      # back to defaults
curl -X POST   $B/__mock/reset         # reseed the store, clear idempotency keys
```

Per-request overrides, so one slow call needs no global state:

```sh
curl -H 'X-Mock-Latency-Ms: 2000' $B/api/v1/health
curl -H 'X-Mock-Error: RATE_LIMITED' -H 'X-Mock-Status: 429' $B/api/v1/reminders
```

Driving the socket:

```sh
curl -X POST $B/__mock/presence   -d '{"state":"thinking","intensity":0.6,"ttl_ms":9000}'
curl -X POST $B/__mock/broadcast  -d '{"fixture":"ws/server_chat_message"}'
curl -X POST $B/__mock/disconnect          # drop every socket, to exercise replay
curl $B/__mock/routes                      # every operation
curl $B/__mock/state                       # row counts, sockets, last seq
```

## The fixtures are the gate

`fixtures/` is what both the TypeScript and the Swift suites decode. A spec both
sides ignore is decoration; a fixture both sides must decode is a gate — Adjutant
shipped iOS models that disagreed with its own backend and paid for it with two
critical bugs found late.

They are plain JSON, not TypeScript objects, so Swift can read the same bytes.
`manifest.json` names the schema each file must validate against, and a test
asserts the manifest lists every file on disk — a fixture cannot be added,
never validated, and quietly rot.

```ts
import { fixture, loadFixture, fixtureEntries } from "@syl/shared";

const frame = fixture("ws/presence_speaking");
```

To add one: write the JSON, add it to `manifest.json`, run `npm test`.

## Things that will bite you

- **`ttl_ms` is the only snake_case field on the wire.** It is quoted as literal
  JSON in three separate sources. Do not "fix" it, and do not add a second one.
- **There are two sequence spaces.** `message.seq` is per-conversation; the
  frame `seq` is per-socket. A `delivery_confirmation` frame carries both.
  Feed the wrong one to `sync` and a client either replays everything or
  silently believes it is caught up. See `ws-protocol.md` §2.
- **`GET /sync` takes `since`; the socket `sync` frame takes `sinceSeq`.** They
  are named apart on purpose and are not interchangeable.
- **Presence is never replayed and carries no `seq`.** Replaying "thinking"
  from four minutes ago is a lie. See `ws-protocol.md` §5.
- **Timestamps are UTC with a `Z`, always.** A fixed offset is a property of an
  instant, not of a place, and one that reaches a fixture becomes a fixed
  offset in a hand-written Swift model that survives exactly one DST boundary.
