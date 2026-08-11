# Syl — Make Her Live

**Feature**: 003-make-her-live
**Epic**: `syl-007`
**Status**: Planned
**Priority**: P0
**Depends on**: `syl-002` (the delivery chain)

## Summary

Everything built so far is green CI. Syl has never woken up on her own and sent the Commander anything.

This epic converts a passing test suite into an assistant that is actually running on his machine, reachable from his phone, and awake at 07:00. It is the difference between a system that *works* and a system that is *working*.

## Why this is its own epic, and why it should come early

Most of it is **configuration rather than code**, which is precisely why it would otherwise never get done. There is always something more interesting to build than a certificate renewal job.

And it gates everything after it. We cannot tune a memory system nobody is using, and we cannot learn what to demote from a rhythm nobody receives. Building the organs before she is alive means building them blind and discovering what is wrong months later.

## The acceptance criterion

> **Syl wakes up on her own, sends the Commander something at the right wall-clock moment, on his phone — and survives a reboot, a sleep/wake cycle, and a power cut.**

If that sentence is not demonstrably true, this epic is not done, regardless of how many beads are closed.

## User stories

### US1 — She is always there (P0)

**As** the Commander, **I want** Syl running whether or not I am at the machine, **so that** she is dependable rather than attended.

- The Mac does not sleep, and comes back on its own after a power cut
- The service starts at boot, before anyone logs in
- A crashed service restarts; a **wedged** service is noticed and restarted too
- Logs exist, are rotated, and are readable when something has gone wrong

### US2 — She reaches him from anywhere (P0)

**As** the Commander, **I want** my phone to reach her from outside the house, **so that** she is not a desk toy.

- Tailscale on the Mac runs as a daemon from boot, not as a logged-in app
- The tailnet node does not expire off the network
- HTTPS works with no App Transport Security exception, and the certificate renews itself
- The app reaches her over cellular with Wi-Fi off — **tested, not assumed**

### US3 — The app is on his phone (P0)

**As** the Commander, **I want** Syl installed and receiving pushes, **so that** the delivery guarantee is real rather than theoretical.

- A build ships through the pipeline and installs
- APNs is pointed at **production**, and the service asserts that at startup rather than discovering it via `BadDeviceToken`
- A push sent from the service arrives on the device

### US4 — Proof of life (P0)

**As** the Commander, **I want** to see her do it unattended, **so that** I believe it.

- A reminder set the previous day arrives correctly the next morning, with the machine having slept and woken in between
- The service is killed and comes back on its own
- The machine is rebooted and everything returns without a human

## Explicitly out of scope

Memory, the life model, the daily rhythm's content, connections, and the character. This epic makes the existing capability *run*; it adds no new capability.

## Constraints

All five non-negotiables, plus one that this epic is the first real test of: **the credential source must be asserted in production, not assumed.** The health endpoint already reports it. This is where it stops being a nicety.
