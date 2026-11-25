# RivetKit actors

Actors own durable state for users, sessions and work items. Follow the actor that owns the write.

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx ../scripts/timeline-write-check.ts` checks session timeline writes.
- `cd server && npx tsx ../scripts/idempotency-check.ts` checks retried requests.
- `cd server && WLP_CHECK_SECTIONS=seal npx tsx ../scripts/signin-check.ts` checks sealing.

## Key files

- `./user.ts` owns account state and the actions that create sessions and items. [Sign-in](./user/signin.ts) and [usage](./user/usage.ts) own their account operations.
- `./agent-session.ts` owns the live turn, its SQLite timeline and client snapshots. Its [session modules](./agent-session/timeline.ts) share the write queue and own timeline, questions, runner binding, summary and workspace recovery.
- `./work-item.ts` commits blueprint outcomes, performs queued effects and schedules retries.
- `./internal.ts` defines actor-to-actor calls and the service credentials they use.

## Non-obvious patterns

- Session actions interleave at every await. Assign sequence numbers synchronously and send writes through the session's serial queue.
- Pass repository secrets sealed between actors. Open them for the active turn, redact its outputs and keep plaintext out of metadata and timelines.
- Use the internal helpers for cross-actor calls. Check the service token's purpose in the receiving action before reading or writing state.

## See also

[Registry](../registry.ts) wires the actors. [Factory](../factory/AGENTS.md) owns the decisions a work item applies.
