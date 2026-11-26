# Server guide

Start with the area guide below before editing its code. Paths are repository-root relative.

## Folder layout

- `server/src/actors/` owns durable users, sessions and work items; see `server/src/actors/AGENTS.md`.
- `server/src/factory/` decides work-item transitions and feature plans; see `server/src/factory/AGENTS.md`.
- `server/src/github/` handles App access, publishing and webhooks; see `server/src/github/AGENTS.md`.
- `server/src/repo-setup/` validates setup guides and prepares setup changes; start with `server/src/repo-setup/guide-check.ts` and `server/src/repo-setup/publish.ts`.
- `server/src/sandbox/` provisions workspaces and runs turns; see `server/src/sandbox/AGENTS.md`.
- `server/src/registry.ts` wires actors; `server/src/index.ts` is the server entry point.

## Shared contract

`server/src/contract.ts` holds shared wire types and runtime constants, with modules in `server/src/contract/`.
Keep its runtime imports browser-safe, as required by `server/src/contract.ts`.
`web/tsconfig.json` maps `@contract` to this file and includes it in the web typecheck.
Run both typechecks for server changes: `web/tsconfig.json` also enables unused-local and unused-parameter checks.

## Typecheck first

Run each command from the repository root in a fresh shell, following `AGENTS.md`.

```sh
cd server && npx tsc --noEmit -p .
```

```sh
cd web && npx tsc --noEmit -p .
```

The configurations are `server/tsconfig.json` and `web/tsconfig.json`.

## Pick a focused check

`scripts/ci-groups.json` maps changed paths to checks, environments, shard arguments and images.
Use that map rather than assuming one folder selects only one group.

| Area | Check paths | CI groups in `scripts/ci-groups.json` |
| --- | --- | --- |
| Actor retries and credentials | `scripts/idempotency-check.ts`, `scripts/signin-check.ts` | `actors` |
| Factory transitions and feature planning | `scripts/factory-check.ts`, `scripts/orchestrator-check.ts` | `factory` |
| GitHub linking/publishing and event delivery | `scripts/github-check.ts`, `scripts/webhook-check.ts` | `rules`, `webhook`; Docker publishing in `sandbox-docker` |
| Repository setup and readiness | `scripts/readiness-check.ts` | `rules` (check key `repo-setup`) |
| Sandbox relay and Docker behaviour | `scripts/model-relay-route-check.ts`, `scripts/sandbox-check.ts` | `rules`, `sandbox-docker` |

For example, run this installation-linking section from the repository root (`server/src/github/AGENTS.md`):

```sh
cd server && WLP_CHECK_SECTIONS=connect npx tsx ../scripts/github-check.ts
```

Use the area guides above for selectors; leave whole suites and image-backed checks to CI (`AGENTS.md`).
`scripts/AGENTS.md` explains selection; `docs/testing.md` lists check prerequisites.
After changing guides, run `node scripts/agents-docs-check.ts` from the repository root.
