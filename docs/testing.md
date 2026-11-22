# Testing

Two workflows run the checks on GitHub Actions.

- **CI** (`.github/workflows/ci.yml`) runs on every push and pull request: the typecheck and the web
  build, `pnpm test` (the fake suite, `WLP_SANDBOX=fake`) and the secret scan. These are the required
  checks on `main`.
- **CI heavy** (`.github/workflows/ci-heavy.yml`) runs everything else that can run on a GitHub runner,
  in groups chosen by the files a change touches. It runs on pushes to `main` and `wip/**`, on pull
  requests, every night, and on demand.

## What a change runs

`scripts/ci-groups.json` is the map. Each group lists the paths it covers and the checks it runs, and
each group (or each shard of one) is one job. `scripts/ci-heavy.mjs select` reads the changed files
against the merge base (the pull request's base, or `main` for a branch) and picks the groups:

- a file that a group lists runs that group;
- a core file (the package files, the lockfile, `server/src/contract.ts`, the CI files) runs every group;
- documentation (`docs/**`, any `*.md`) runs nothing, and neither does a file no group lists;
- a push to `main`, the nightly run and a dispatch with `full` run every group.

The Docker groups load the sandbox images from the Actions cache. The `images` job builds each image
once per run, with `docker buildx` and the GHA cache, so an unchanged Dockerfile builds nothing. The
runners are `ubuntu-24.04` (x86-64): every image, the Windlass release and the engine have an x86-64
build. Those jobs set `kernel.apparmor_restrict_unprivileged_userns=0` first: Ubuntu 24.04 keeps
unconfined processes out of user namespaces, so bubblewrap cannot start in a container of the Windlass
profile (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`) until it is off.

To see what a change would run, before you push:

```sh
node scripts/ci-heavy.mjs select --base origin/main             # what a push of HEAD would run
node scripts/ci-heavy.mjs select --files server/src/usage.ts    # what a change to these files would run
```

## The checks by what they need

| Class | Checks | Where |
| --- | --- | --- |
| (a) Fake sandbox, no Docker | access, account, attachments, backup, connection, harness, models, repository, review, reviewer-task, runner-control, runner-protocol, secrets, setup, usage, verified, web-files, github, shot, sizing, e2b-provider-test, workflow-lint; idempotency, signin, connection-e2e, http-limits; frame-auth, machine, runner-e2e, runner-socket-probe; factory-e2e (all sections), webhook-check (all sections) | CI heavy: `rules`, `actors`, `machines`, `factory/*`, `webhook` |
| (a) Already in `pnpm test` | e2e.ts (fake), factory-check, orchestrator-check, fairness, machine-fairness (through `runner-e2e.ts fairness`), timeline-write, web-stage, item-feed, keyring, login-handover, revocation, snapshot, container-logs, the relay and setup `.mjs` checks, release-images (which drives release-check.ts), the web vitest suite | CI `test` |
| (b) Docker, base image (`windlass-platform-sandbox:latest`) | sandbox, mcp, github `--docker`, verified `--docker`, e2b-provider-test `--docker`, sizing `docker`; e2e.ts with `WLP_SANDBOX=docker`, and with `--snapshots-only` | CI heavy: `sandbox-docker/*` (sandbox-check in two shards by `WLP_CHECK_SECTIONS`), `e2e-docker/*` |
| (b) Docker, screenshots image (`:shots`) | shot `--docker`, attachments `--docker` | CI heavy: `shots-docker` |
| (b) Docker, base and screenshots, runner and Claude images it builds itself | runner-check | CI heavy: `runner-docker/runner` |
| (b) Docker, Claude and OpenCode images built on base (`sandbox/harness/build.sh`) | claude-relay-docker, opencode-docker, runner-egress-live, `runner-e2e.ts egress` | CI heavy: `runner-docker/harness` |
| (c) Real services, local only | e2b-check, e2b-backup-check, e2b-template (except `--print`), e2b-cleanup (an E2B account); backup-check `--bucket` (a real bucket); connection-check's `cluster` section and runner-socket-probe with `WLP_CHECK_ENGINE` (a real engine and its admin token) | your machine |
| (c) A running self-hosted stack, local only | selfhost-csp, selfhost-ingress (with cloudflared), selfhost-load | the loopback demo stack of `deploy/selfhost` |

Account and secrets checks compare against Windlass's own source when `WLP_WINDLASS_SOURCE` points at a
checkout; on CI that comparison is skipped and the rest runs.

## For agents

1. **Locally, run little.** This host is shared and small. Run `pnpm typecheck` and the one check that
   covers what you changed (`cd server && npx tsx ../scripts/<name>.ts`), nothing more. Leave the
   Docker checks, the e2e runs and the full suite to CI.
2. **Push a `wip/<name>` branch** to `git@github.com:WindlassAI/windlass-platform.git`
   (`git push origin HEAD:wip/<name>`). Both workflows run on it. The plan job's summary says which
   groups ran and which changed file chose each one; each job's summary has a table of its checks with
   their times.
3. **Read the result** with one call per look, no more than once a minute:
   `gh run list -b wip/<name> -L 2 --json databaseId,name,status,conclusion`, then
   `gh run view <id> --json jobs` and `gh run view <id> --log-failed` for a failure. Do not use
   `gh run watch`: it uses up the shared API allowance.
4. **Force a full run** when a change reaches further than its paths say (a new shared helper, say):
   `gh workflow run ci-heavy.yml --ref wip/<name> -f full=true`. Every push to `main` and the nightly
   run are full runs already. On a branch stacked on another, `-f base=<parent branch or commit>` chooses
   by the changes since that parent rather than since `main`.

When you add a check, put it in a group of `scripts/ci-groups.json`, with the paths it covers.
