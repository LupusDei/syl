# Beads — Syl: The Bones

**Four root epics, not one.** A squad owns an epic; a single epic means nothing can be handed off cleanly. `syl-001` is the only serial one — the other three run in parallel behind it.

```
syl-001  Bones and the API contract      ← one squad, blocks everything
   │
   ├──► syl-002  The service              ← squad 2   ┐
   ├──► syl-003  The mobile app           ← squad 3   ├─ parallel, no shared files
   └──► syl-004  The web admin            ← squad 4   ┘
```

**59 beads total.** The handoff point is `syl-001.2.5` — the mock server. Once it is up, the three tracks stop depending on each other.

---

## syl-001 — Bones and the API contract (18 beads)

| Bead | Title |
|---|---|
| `syl-001.1` | **Setup** — serial, blocks everything |
| `syl-001.1.1` | Upgrade to Node 22 |
| `syl-001.1.2` | Restructure to a monorepo |
| `syl-001.1.3` | Workspace tooling |
| `syl-001.1.4` | CI skeleton |
| `syl-001.2` | **The contract** |
| `syl-001.2.1` | Author the OpenAPI spec |
| `syl-001.2.2` | WebSocket frame schema |
| `syl-001.2.3` | Generate shared TypeScript types |
| `syl-001.2.4` | Shared JSON fixtures |
| `syl-001.2.5` | **Mock server** ← the handoff point |
| `syl-001.2.6` | Contract tests in CI |
| `syl-001.3` | **Harness hardening** — parallel with the contract |
| `syl-001.3.1` | Turn timeout in runTurn |
| `syl-001.3.2` | Session lanes |
| `syl-001.3.3` | Pre-generated session id |
| `syl-001.3.4` | Reader turn shape, no tools |

## syl-002 — The service (21 beads)

| Bead | Title |
|---|---|
| `syl-002.1` | **Core service** |
| `syl-002.1.1` | Service skeleton and health |
| `syl-002.1.2` | SQLite, migrations, asset copy guard |
| `syl-002.1.3` | Auth |
| `syl-002.1.4` | Message and conversation store |
| `syl-002.1.5` | WebSocket server with replay |
| `syl-002.2` | **Delivery** — owns constraint 4 |
| `syl-002.2.1` | Device tokens and APNs sender |
| `syl-002.2.2` | Delivery outbox |
| `syl-002.2.3` | Reminders and the zero-turn delivery job |
| `syl-002.3` | **Runtime and supervision** |
| `syl-002.3.1` | Job runner |
| `syl-002.3.2` | launchd agents |
| `syl-002.3.3` | Presence emitter |
| `syl-002.4` | **Connections bones** |
| `syl-002.4.1` | Fetcher and SSRF guard |
| `syl-002.4.2` | Article intake end to end |
| `syl-002.4.3` | Plus-addressed intake mailbox |
| `syl-002.5` | **Proof** |
| `syl-002.5.1` | End-to-end reminder proof |

## syl-003 — The mobile app (12 beads)

| Bead | Title |
|---|---|
| `syl-003.1` | **Foundation** |
| `syl-003.1.1` | Xcode project and SylKit skeleton |
| `syl-003.1.2` | SylKit networking |
| `syl-003.1.3` | SylKit WebSocket client |
| `syl-003.2` | **Local-first store** |
| `syl-003.2.1` | Local-first store and outbox |
| `syl-003.3` | **The app** |
| `syl-003.3.1` | App shell and push registration |
| `syl-003.3.2` | Chat UI |
| `syl-003.4` | **Release pipeline** |
| `syl-003.4.1` | TestFlight pipeline |

## syl-004 — The web admin (8 beads)

| Bead | Title |
|---|---|
| `syl-004.1` | **Foundation** |
| `syl-004.1.1` | Admin shell |
| `syl-004.1.2` | Admin API client |
| `syl-004.2` | **Viewers** |
| `syl-004.2.1` | Job and run viewer |
| `syl-004.2.2` | Delivery viewer |
| `syl-004.2.3` | Conversation and device viewers |

---

## Dependency notes

**`bd` derives parent-child from the ID**, so `syl-002.1.1` is already a child of `syl-002.1`. Explicit parent→task edges are rejected as redundant.

**Sub-epic dependencies do not cascade to their children.** This matters: blocking had to be wired at *task* level, or `bd ready` would happily offer the local-first store before the contract existed. It was doing exactly that before the fix.

Cross-epic gates:

```
syl-002.1.1, syl-003.1.1, syl-004.1.1  ←  syl-001.1.3   (skeletons need the monorepo)
everything else in 002/003/004         ←  syl-001.2.5   (the mock)
syl-002.4.2                            ←  syl-001.3.4   (Reader shape gates intake)
syl-002.5.1                            ←  syl-003.3.1   (the proof needs the app)
```

**Verified**: with all 58 edges wired, exactly one task is ready — `syl-001.1.1`. Everything else is correctly blocked.

## File ownership — the property that makes parallelism safe

| Epic | Owns |
|---|---|
| `syl-001` | repo root, `shared/**`, `backend/src/harness/**` |
| `syl-002` | `backend/src/{services,routes,connections,migrations}/**` |
| `syl-003` | `ios/**` |
| `syl-004` | `frontend/**` |

No two epics write the same file. Preserve this as tasks are refined — it is what lets three squads run without merge pain, and worktree isolation does the rest.
