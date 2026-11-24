# Web client

Screens use one platform client for live actors and for the in-memory mock.

## Quick commands

Run one command from the repository root.

- `cd web && npx tsc --noEmit -p .` checks the UI and the server modules it imports.
- `cd web && pnpm test src/api/rivet.test.ts` selects the live adapter's tests.
- `cd web && pnpm test src/docs/docs.test.ts` selects documentation checks. Substitute the adjacent test file for other edits.

## Key files

- `App.tsx` selects screens from the current route.
- `api/client.ts` defines the actions and live feeds that screens consume.
- `api/rivet.ts` adapts actor calls, connections and snapshots to that interface.
- `api/mock.ts` implements the client used without a backend.
- `docs/pages.ts` lists the user documentation in reading order.

## Non-obvious patterns

- Change the client interface and both adapters together when adding an action. [Contract](../../server/src/contract.ts) supplies the shared shapes.
- Rebuild a feed from a fresh snapshot after reconnect. Events broadcast during the disconnect are lost.
- Add behaviour pages under [docs content](docs/content/) and register them in the page list so the UI can find them.

## See also

[Web image check](../../scripts/web-stage-check.ts) checks which imported files the Docker build copies. [Actors](../../server/src/actors/AGENTS.md) own the live data.
