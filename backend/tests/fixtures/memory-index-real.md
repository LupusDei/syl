# Adjutant Project Memory

## iOS / Build
- [ios_livekit_toolchain_network_hang.md](ios_livekit_toolchain_network_hang.md) — sim builds hang on LiveKit networking (xcodebuild `waitForRemoteSourcePackagesToFinishLoading` + `swift build` webrtc-xcframework download) though curl/git work; workaround = standalone LiveKit-free SwiftPM pkg copying feature source, render real view via ImageRenderer, run pure XCTests on-host (adj-208.4: clean, 28/28, renders correctly)
- iOS uses SPM (Package.swift at `ios/`) auto-discovering ALL `.swift`; NEVER add `Adjutant/` files to `.pbxproj` (only AdjutantApp.swift + AppDelegate.swift are, excluded from SPM); `AdjutantKit/` is a separate auto-discovering package; disambiguate SwiftUI `Task<Void, Never> { }`
- [worktree_verify_from_worktree_dir.md](worktree_verify_from_worktree_dir.md) — run lint/build/tsc from the worktree dir, NOT canonical repo; repo-root build misses branch-local lint errors (bit adj-202.11)

## Runway / Avatar
- [bridge_transcript_transport_findings.md](bridge_transcript_transport_findings.md) — avatars-node-rpc hides its LiveKit room (fork to capture on same conn); rtc-node has no TranscriptionReceived — transcription via `lk.transcription` text streams; Runway publish still unverified (STT fallback)

## Worktrees / Git
- [worktree_push_default_upstream_trap.md](worktree_push_default_upstream_trap.md) — `checkout -b X origin/main` + push.default=upstream makes bare `git push` target main (rejected); push via `git push origin HEAD:refs/heads/X`
- [squad_worktree_checkout_leak.md](squad_worktree_checkout_leak.md) — bg worktree agents' checkout flips canonical repo branch (adj-iqyqw); re-checkout main + verify HEAD before coordinator git ops; never tell reviewers to checkout main
- Stale-branch conflicts (adj-yzvk): worktrees prevent concurrent-edit but NOT stale-branch conflicts — spawn Phase N agents only after Phase N-1 merges, or rebase often
- Coordinator MUST run in main repo, never a worktree (worktree breaks `.beads/` access + stale git state)

## Beads / Dolt
- [bd_head_embeddeddolt_provisioning.md](bd_head_embeddeddolt_provisioning.md) — fresh bd-HEAD init stores at `.beads/embeddeddolt` but supervisor hardcodes `.beads/dolt`; point launchd at embeddeddolt (proper fix adj-gkrt3)
- [bd_write_fix_0043_entanglement.md](bd_write_fix_0043_entanglement.md) — bd 1.0.4 #4170 write-hang fix needs the 0043 migration; validated quiesce-and-migrate runbook
- [dolt_server_swap_issues_jsonl_selfheal.md](dolt_server_swap_issues_jsonl_selfheal.md) — killing dolt loses uncommitted set; bd 1.0.4 re-imports from issues.jsonl. Before swap: `autocommit:true` or `bd dolt commit`; new server cwd == `.beads/dolt`
- [fleet_dolt_supervised_endstate.md](fleet_dolt_supervised_endstate.md) — all projects run launchd-supervised autocommit dolt on pinned ports 17000-17010; NEVER drop the `dolt_server_port` pin; bloomfolio-backlog pending (adj-182.3.7)
- [dolt_port_file_and_heal_watchdog.md](dolt_port_file_and_heal_watchdog.md) — bd dials `.beads/dolt-server.port` (authoritative) not metadata; stale port file = "unreachable"; self-heal `~/.adjutant/dolt-heal.sh` (launchd 120s); `bd dolt status` lies, use `bd list`; macOS has no `timeout`

## Spawning / Agents
- Spawn prompts: include explicit `bd` CLI instructions + bead IDs (`bd update <id> --assignee=<name> --status=in_progress`) + `Your name (for --assignee): <name>`; beads is source of truth, NOT TaskCreate/TaskUpdate
- [feedback_coordinator_spawning.md](feedback_coordinator_spawning.md) — coordinator uses `spawn_worker` MCP tool (dashboard-visible, MCP-capable), counts vs MAX_SESSIONS=10; do NOT use for other projects (inherits context)
- Delegate: when user says "create/spawn a teammate", use `mode: "delegate"` on Task tool
- `bypassPermissions` on spawned agents is unreliable — monitor early, ask user rather than work around
- Decommission: NEVER `decommission_agent` without explicit user request (soft kill only — leaves tmux + registry slot)
- [tmux + dolt-hook + panic-spawn](squad_worktree_checkout_leak.md) — tmux input = set-buffer+paste-buffer, 150ms, send-keys Enter (input-router/lifecycle-manager); `.git/hooks/post-checkout` must skip worktrees (`[ -f .git ]`, dolt panics on concurrent access; re-apply if `bd init` regenerates); don't panic-spawn duplicates — assess + resolve blocker first
- Relational: Raynor catches test-coverage/integration-boundary gaps; Kerrigan catches race/timing bugs

## Process / Directives
- [feedback_message_scoping.md](feedback_message_scoping.md) — agents MUST use `agentId` filter reading messages (`read_messages({agentId,limit})`); unscoped reads miss direct instructions
- [feedback_project_identity_standard.md](feedback_project_identity_standard.md) — projectId (UUID) is the ONLY backend/API key; projectName display-only; projectPath only for CWD + .beads/
- [feedback_auto_develop_autonomous.md](feedback_auto_develop_autonomous.md) — never wait for approval, execute on best assumptions, spawn each phase; escalate only vision/blockers
- [feedback_auto_develop_loop_design.md](feedback_auto_develop_loop_design.md) — VALIDATE thorough (spec intent + usability); IDEATE includes research; never-idle: research→refine→escalate x3→pause
- [feedback_proposal_review_bias.md](feedback_proposal_review_bias.md) — coordinator must NOT score proposals it created; assign independent reviewer
- [feedback_review_responsiveness.md](feedback_review_responsiveness.md) — when reviewer done, IMMEDIATELY check messages
- [feedback_proposal_completion_strategy.md](feedback_proposal_completion_strategy.md) — coordinator marks proposals complete during VALIDATE; `bd` CLI bypasses EventBus
- [feedback_verify_before_nudging.md](feedback_verify_before_nudging.md) — check cost/token spend before nudging; status-check when unsure
- [feedback_check_config_before_assuming.md](feedback_check_config_before_assuming.md) — read `.mcp.json`/config before API calls, never guess ports
- [feedback_never_raw_sql_phase_changes.md](feedback_never_raw_sql_phase_changes.md) — use `advance_auto_develop_phase` MCP tool; raw SQL bypasses EventBus

## Graduated to Constitution (2026-04-17)
Recurring corrections promoted to `constitution.md` (authoritative there): MCP communication (Rule 5), Bead discipline (Rule 6), Agent isolation (Rule 7), Project scoping (Rule 8), Real data in tests (Rule 1). Retained feedback files: `feedback_always_use_mcp_messages.md`, `feedback_message_scoping.md`, `feedback_agent_project_scoping_strict.md`, `feedback_cross_project_beads.md`
