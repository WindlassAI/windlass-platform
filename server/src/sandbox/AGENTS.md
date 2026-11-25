# Hosted sandboxes

Actors ask the sandbox layer to provision a workspace and run a turn on Docker or E2B.

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx ../scripts/model-relay-route-check.ts` exercises the hosted relay route.
- `cd server && npx tsx ../scripts/e2b-provider-test.ts` exercises E2B with a stand-in.
- For a single section with CI's base image, use `cd server && WLP_CHECK_SECTIONS=profiles npx tsx ../scripts/sandbox-check.ts`.

## Key files

- `./api.ts` defines the actor-facing sandbox interface and errors.
- `./provider.ts` defines the operations turn code can ask of a sandbox.
- `./turn.ts` coordinates a Windlass turn over that provider interface.
- `./model-relay.ts` manages Docker relay containers and per-turn forwarders.
- `./relay-leases.ts` holds E2B turn credentials and resolves their signed placeholders.

## Non-obvious patterns

- Put common turn behaviour behind the provider interface. Check both the [Docker](./sandboxes.ts) and [E2B](./e2b/sandboxes.ts) implementations when changing it.
- Model relay token files in sessions contain a per-turn placeholder. Refresh the real credential at the relay and revoke access when the turn closes.
- A signed E2B placeholder can reach another server process. The process hosting the session actor owns the live lease.

## See also

[Runner](../../../runner/src/AGENTS.md) reuses the Docker operations. [Model relay](../../../docs/model-relay.md) describes the credential lifetime.
