# Contract tests

> **Status: the TypeScript half is done and gating CI. The Swift half is not
> written, because `ios/` does not exist yet.** Everything it needs is here and
> is stable; see §3 for exactly what to implement. Tracked as `syl-001.2.6`,
> which stays open until the Swift suite lands.

## 1. Why this exists

Adjutant shipped iOS models that disagreed with its own backend responses. The
mismatch produced two critical bugs, both found late, and the fix cost a
backfill migration with an audit log.

The lesson is not "write a spec". Adjutant had one.

**A spec both sides ignore is decoration. A fixture both sides must decode is a
gate.** So the contract is enforced by making the same bytes pass through both
type systems, on every push, rather than by asking anyone to read `openapi.yaml`
carefully.

## 2. The shape of the gate

```
shared/openapi.yaml                 the contract
        |
        |  npm run contract:generate
        v
shared/src/types.ts ---------------- drift gate (tests/drift.test.ts)
shared/schemas/ws.json  ------------ drift gate
        |
shared/fixtures/**  + manifest.json
        |
        +---> TypeScript: tests/fixtures.test.ts        DONE, gating CI
        |
        +---> Swift: ios/SylKit/Tests/ContractTests     TO DO
```

Three independent failures are caught:

| Failure | Caught by |
|---|---|
| The spec changed and nobody regenerated | `tests/drift.test.ts` |
| A fixture stopped matching the spec | `tests/fixtures.test.ts` |
| A hand-written Swift model stopped matching the fixtures | the Swift suite |

The third is the one that bit Adjutant, and it is the one still outstanding.

## 3. What the Swift suite must do

`ios/SylKit` models are **hand-written** — there is no Swift generator worth the
dependency for a surface this size, and a generated model nobody in the repo
owns is its own liability. Hand-written is fine precisely *because* this gate
exists.

The suite must:

1. **Read `shared/fixtures/manifest.json`.** Do not hard-code a file list. The
   manifest is what stops a fixture being added and never decoded — the
   TypeScript side already asserts the manifest lists every file on disk, so
   reading it means both sides see the same set by construction.

2. **For each entry, decode the file with `JSONDecoder` into the model named by
   `schema`.** Envelope handling:
   - `envelope: "ok"` — the file is `{ "success": true, "data": … }`. Decode as
     `Envelope<T>` and check `data` against the named type.
   - `envelope: "raw"` — the file *is* the named type. Decode directly.

3. **Fail on unknown or missing keys.** A decoder that silently tolerates a
   field the server stopped sending is not a gate. The one deliberate exception
   is `PresenceState`, which is an **open** enum: an unrecognised value must
   decode to `.idle`, never throw. (See `ws-protocol.md` §5 — a client that
   rejects the frame is a client that breaks on a server deploy.)

4. **Round-trip the encodable types.** Encode the decoded value and compare to
   the original JSON semantically. This is what catches a `CodingKeys` typo in
   the *write* direction, which decoding alone never exercises — and every write
   path here carries an idempotency key, so a wrong key name means a duplicated
   reminder rather than a compile error.

5. **Run on every push**, in the same workflow as the Swift unit tests.

### The four places Swift will get it wrong

These are known in advance, so they should be tests rather than discoveries.

- **`ttl_ms`** is the only snake_case field on the wire. Every other field is
  camelCase, so a blanket `.convertFromSnakeCase` decoding strategy is **wrong**
  — it would rewrite `ttl_ms` to `ttlMs` and leave everything else mangled. Use
  explicit `CodingKeys`.
- **Dates.** Instants are RFC 3339 UTC with millisecond precision and a literal
  `Z`. `.iso8601` does **not** parse fractional seconds; use
  `.iso8601withFractionalSeconds` or a custom formatter. A fixed offset must
  never appear — it is a property of an instant, not of a place, and one that
  reaches a model survives exactly one DST boundary.
- **Nullable versus absent.** The contract marks almost every nullable field as
  *required and nullable* (`"x": null`), not optional. `T?` decodes both, so
  the difference is invisible on read and appears only when encoding. Round-trip
  tests (step 4) are what catch it.
- **The two sequence spaces.** `WsDeliveryConfirmation` has both `seq` (the
  frame stream) and `messageSeq` (the conversation). They are different numbers.
  Modelling one and reusing it for the other compiles fine and desynchronises
  the socket. See `ws-protocol.md` §2.

### Suggested layout

```
ios/SylKit/Tests/ContractTests/
  ContractTests.swift        walks the manifest, decodes everything
  FixtureLoader.swift        locates shared/fixtures/ from the test bundle
  PresenceDecodingTests.swift  the open-enum rule
  RoundTripTests.swift       encode-side CodingKeys
```

`shared/fixtures/` must be referenced, not copied. A copied fixture is a fixture
that drifts, which is the exact failure this whole mechanism exists to prevent.

## 4. What runs today

```sh
npm test          # includes both gates
npm run typecheck
```

`.github/workflows/ci.yml` runs `npm test` and a blocking coverage step on every
push and pull request to `main`, so the TypeScript half of this gate is already
enforced. Adding the Swift job is the remaining work.
