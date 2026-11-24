# Machine runner

The runner pairs a user's machine, keeps its server connection open and executes sandbox operations locally.

## Quick commands

Run one command from the repository root.

- `cd runner && npx tsc --noEmit -p .` checks runner code and imported server types.
- `cd server && npx tsx ../scripts/runner-protocol-check.ts` covers reconnect, replay and invalid frames.
- `cd server && RUNNER_E2E_ONLY='^a fresh Claude session' npx tsx ../scripts/runner-e2e.ts inventory` checks the catalog advertised before the first turn.

## Key files

- `main.ts` dispatches the CLI commands and validates their options.
- `control.ts` pairs the machine and maintains its control connection.
- `session.ts` handles per-session operations, streamed output and cancellation.
- `docker-executor.ts` creates and manages the local containers and their resources.
- `claude-relay.ts` provisions harness relays and projects placeholder credentials into sessions.

## Non-obvious patterns

- Change session wire messages in the shared [protocol](../../server/src/runner/protocol.ts). Both endpoints import its types and validation rules.
- Scrub harness output before sending or retaining frames. Reconnect can replay output already buffered by the channel.
- Mount the login volume on the relay. The session gets a placeholder bearer for its requests.

## See also

[Sandbox layer](../../server/src/sandbox/AGENTS.md) supplies the Docker handles. [Runner behaviour](../../web/src/docs/content/runner.md) covers setup and operation.
