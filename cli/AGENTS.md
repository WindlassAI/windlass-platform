# CLI

`@windlassai/cli` (bin `windlassai`) is what a user runs with npx on their own computer. It is bundled to one
file with no runtime dependencies by `./build.mjs` (the package bin). It stays private until the npm org exists.

## Quick commands

Run one command from the repository root.

- `cd cli && npx tsc --noEmit -p .` typechecks the CLI and the one server module it imports.
- `cd cli && node --test test/token.test.ts` checks reading the token off captured terminal output.
- `cd cli && node --test test/connect.test.ts` runs the whole flow against a stand-in platform and `claude`.
- `cd cli && node build.mjs` writes the bundle.

## Module map

- `./src/main.ts` parses the command line; `connect codex` and `connect --machine` are named but not built.
- `./src/connect.ts` runs `connect <plan>`: start, browser approval, poll, token, hand-over (`PLAN_SOURCES`).
- `./src/setup-token.ts` runs `claude setup-token` under `script` and keeps its output in memory.
- `./src/token.ts` reads the token off terminal output and scrubs secrets out of messages.
- `./src/platform.ts` resolves the platform address and posts JSON; `./src/terminal.ts` is the browser and prompts.

## Invariants

- The wire (`CONNECT_PATHS`, `ConnectStart`, `validPlanToken`) comes from `server/src/contract/connect.ts`; keep that module import-free.
- Never print, log or write the token. Every error goes through `scrub` in `./src/token.ts`.
- The server side is `server/src/connect-route.ts`; its checks are in `scripts/model-plans-check.ts`.
