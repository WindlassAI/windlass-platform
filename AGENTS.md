# Working in Windlass Platform

Make the smallest change that solves the task. Start with the guide in the area you touch.
Run each command below from the repository root in a fresh shell.

## Set up

Use the pnpm version pinned in `package.json`. CI installs from the lockfile.

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
```

## Typecheck first

Server typecheck

```sh
cd server && npx tsc --noEmit -p .
```

Web typecheck

```sh
cd web && npx tsc --noEmit -p .
```

Always run **both** before merging server changes. Web follows imports into `server/src`
under stricter settings, including unused locals and parameters. Server can pass while web fails.
Runner changes also need `cd runner && npx tsc --noEmit -p .`.

## If you change X, run Y

After typechecking, pick the check for the behaviour you changed. Run one file or case at a time.
The area links lead to copyable commands. For other checks, look up the changed path in
`scripts/ci-groups.json` or ask the selector which groups cover it.

| Area | Pick a check | Narrow it |
| --- | --- | --- |
| [Factory](server/src/factory/AGENTS.md) | `scripts/factory-check.ts` for transitions, `scripts/orchestrator-check.ts` for features, `scripts/factory-e2e.ts` for the actor | Only the E2E reads `FACTORY_ONLY`, e.g. `FACTORY_ONLY=memory`. |
| [Actors](server/src/actors/AGENTS.md) | `scripts/timeline-write-check.ts` for session writes, `scripts/idempotency-check.ts` for retries, `scripts/signin-check.ts` for credentials | The sign-in and `scripts/connection-check.ts` checks use `WLP_CHECK_SECTIONS`, e.g. `seal` and `issuing` respectively. |
| [Sandbox](server/src/sandbox/AGENTS.md) | `scripts/model-relay-route-check.ts` for leases, `scripts/e2b-provider-test.ts` for the provider, `scripts/sandbox-check.ts` for Docker | On the Docker check use `WLP_CHECK_SECTIONS=profiles`. The Codex image check `scripts/codex-sandbox-escape-check.mjs` takes `WLP_ESCAPE_ONLY` (case-name substring). |
| [GitHub](server/src/github/AGENTS.md) | `scripts/github-check.ts` for the App and publishing, `scripts/webhook-check.ts` for delivery to actors | Use `WLP_CHECK_SECTIONS=connect` for the former and `WEBHOOK_ONLY='G3 feature'` for the latter. |
| [Linear](server/src/linear/AGENTS.md) | `scripts/linear-protocol-check.ts` for HTTP and OAuth, `scripts/linear-check.ts` for filing | Only the filing check takes `LINEAR_ONLY`, e.g. `LINEAR_ONLY=OAuth`. |
| [Runner](runner/src/AGENTS.md) | `scripts/runner-protocol-check.ts` for reconnects, `scripts/runner-e2e.ts` for machine inventory, `scripts/runner-check.ts` for Docker | The E2E takes `inventory` or `fairness` and matches case names against the `RUNNER_E2E_ONLY` regex. Docker uses flags such as `--snapshots-only`. |
| [Web](web/src/AGENTS.md) | Run the adjacent Vitest file, or `scripts/item-feed-check.ts` for the item feed | Give Vitest one file and optionally `-t` with a test name. |
| [Scripts](scripts/AGENTS.md) | `scripts/agents-docs-check.ts` for these guides, `scripts/workflow-lint.ts` for workflow permissions and action pins | Pass one workflow file to the linter. For a changed check, use its own selector above. |

For a server-side check, use the server workspace's installed tsx. This selects the token-issuing case.

```sh
cd server && WLP_CHECK_SECTIONS=issuing npx tsx ../scripts/connection-check.ts
```

`FACTORY_ONLY` and `WLP_CHECK_SECTIONS` match comma-separated case-name prefixes.
`WEBHOOK_ONLY` and `LINEAR_ONLY` each match a single case-sensitive prefix.
Copy the prefix from the script. A typo can leave every matching case unexecuted.

## Leave suites to CI

Never run whole suites locally. Root `pnpm test` takes about 30 minutes.
CI splits it into `pnpm test:factory`, `pnpm test:core`, `pnpm test:usage` and `pnpm test:resume`.
Leave image-backed checks to CI. Heavy checks use changed paths to select jobs. To see which jobs a branch selects, run the selector.

```sh
node scripts/ci-heavy.mjs select --base origin/main
```

[Testing](docs/testing.md) lists the images, services and fixtures each group needs.
On this shared host, keep the PID when starting a process and stop that PID with `kill "$pid"`.
Never use `pkill -f`. It can stop another checkout's server or check.

## Edit and hand off

- Write readable code. Reuse existing code instead of copying it.
- Skip compatibility code for old or stored data. Avoid extra fallbacks.
- Prefer a few clear statements over a dense one-liner.
- Keep comments short and explain why. Skip restatements and long prose blocks.
- `README.md` is frozen. Put behaviour documentation in `web/src/docs/content/*.md`.
- When a guide's paths or commands change, run `node scripts/agents-docs-check.ts`.
- Write one short, plain imperative line for each commit message.
