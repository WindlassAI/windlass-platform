# Runner protocol (server side)

These modules define what the server and a machine's runner say to each other. The [runner](../../../runner/src/AGENTS.md)
imports the same files, so each message type and its validation exist once.

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx ../scripts/runner-protocol-check.ts` covers session-socket reconnect, replay and invalid frames.
- `cd server && npx tsx ../scripts/runner-control-check.ts` covers control-socket parsing, refusals and the second-runner rule.
- `cd server && npx tsx ../scripts/frame-auth-check.ts` covers the handshake and frame MACs.
- `cd server && npx tsx ../scripts/machine-check.ts` covers the machine actor.

## Module map

- `./protocol.ts` is the session socket: `hello`/`welcome`/`msg`/`part`/`ack` frames, the `operations` table (`Name`, `Args`, `Value`), limits such as `MAX_FRAME_BYTES`, `OP_MS` and `RUNNER_GRACE_MS`, and `PROTOCOL_VERSION`.
- `./control.ts` is the machine's control socket and the pre-socket HTTP routes (`/runner/pair`, `/runner/connection`): frames, refusals, `SERVER_CAPABILITIES`, minimum runner versions and signed proof strings.
- `./channel.ts` holds the shared `Channel` with sequence numbers, acks, windows and replay; `ServerChannel` (used by `server/src/sandbox/runner-layer.ts`) and `RunnerChannel` (used by `runner/src/session.ts`).
- `./frame-auth.ts` is protocol 2's per-socket handshake, frame MACs, platform certificate and endpoint pin, plus signed removal and snapshot-retention answers.
- `./journal.ts` keeps the server's half of a conversation in the session actor's SQLite so a restarted server resumes it.
- `./check.ts` holds the combinators (`object`, `list`, `text`, `optional`) whose checks are also types; `Of<C>` extracts the type.
- `./catalog.ts` digests harness options and sends catalog frames only when they change.
- `./spare-recipe.ts` describes a warm spare's repository and setup recipe.
- `./egress.ts` names the restricted runner's proxy address and the `--egress none` refusal.

The actors that speak these protocols are in `server/src/actors/machine.ts`, `server/src/actors/machine-pairing.ts` and the
session's `server/src/actors/agent-session/runner.ts`. The HTTP routes are in `server/src/runner-routes.ts`.

## Invariants

- Validation lives in `./protocol.ts` and `./control.ts` only. Define a field once with `./check.ts`; the `Same`/`Assert` drift types at the end of each file tie the checks to the TypeScript interfaces they carry.
- Checks never throw. Input from the other side is refused, not crashed on.
- `./control.ts` imports only types and checks: no RivetKit, no configuration. It is loaded by the runner and the stand-ins.
- Control frames are never resent; a new socket starts over with a new challenge. Session frames are replayed by sequence within one conversation only.
- Frames that carry secrets (`carriesSecret` in `./channel.ts`) are journalled as a cancel. After a restart the caller supplies fresh credentials.
- Channel methods are synchronous, so actor actions interleave only between calls. On conversation loss, outstanding operations have unknown outcomes.

## Pitfalls

- Older runners connect to newer servers. Gate new fields or behaviour on `SERVER_CAPABILITIES` and version constants such as `CAPABILITIES_RUNNER_VERSION`. `protocolRefusal` words the refusal when `PROTOCOL_VERSION` differs.
- Keep frames under `MAX_FRAME_BYTES`; large messages go out as `part` frames.
- A new operation needs an entry in the `operations` table and a case in the dispatch in `runner/src/session.ts`, which calls into `runner/src/docker-executor.ts`.

## See also

[Sandbox layer](../sandbox/AGENTS.md) defines the provider interface these operations carry.
