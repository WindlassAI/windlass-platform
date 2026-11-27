# GitHub integration

This layer connects installations, publishes session work and admits signed GitHub events.

## Quick commands

Run one command from the repository root.

- `cd server && WLP_CHECK_SECTIONS=connect npx tsx ../scripts/github-check.ts` checks installation linking.
- `cd server && WLP_CHECK_SECTIONS=publish npx tsx ../scripts/github-check.ts` checks publishing.
- `cd server && WEBHOOK_ONLY='G3 feature' npx tsx ../scripts/webhook-check.ts` selects feature filing cases.

`scripts/github-check.ts` section names start with a topic such as `config`, `jwt`, `connect`, `repositories`, `tokens`, `clone`, `publish`, `failures`, `hostile` or `docker`; copy a prefix from its `section(` calls.
`WEBHOOK_ONLY` is one case-sensitive prefix (`G2` CI nudges, `G3` issue filing, `G4` pull request review).
CI runs these in the `rules`, `webhook` and `sandbox-docker` groups of `scripts/ci-groups.json`.

## Module map

Connecting and access

- `./app.ts` is the App client: JWT, installation tokens scoped by `TokenScope`, REST and GraphQL requests, `GithubError`.
- `./state.ts` signs the connect `state` (ten minutes) and the callback `ticket` (five minutes), and makes PKCE verifiers.
- `./connect.ts` serves `GET /github/callback`: checks the state, exchanges the code and returns a ticket to the web app.
- `./repos.ts` decides which repositories a connected user may list, launch on or push to, asking GitHub per user; caches only briefly in memory.
- `./ids.ts` parses GitHub JSON keeping large numeric IDs exact, and recognizes the App's own checks (`ownApp`).
- `./redact.ts` strips known and GitHub-shaped tokens, and routed provider keys, from text before it is shown or logged.
- `./problem.ts` defines `GithubProblem`, a user-facing failure whose `code` is a `UserError` code.

Events

- `./webhook.ts` is the `/github/webhook` route: header checks, size limit, HMAC over the raw bytes, then `githubInbox` admission.
- `./events.ts` trims each supported event (`edge`) to the lookup fields in `Delivery`; nothing else crosses the actor boundary.
- `./issues.ts` reads an issue subject; a 404, 410 or 422 means "nothing proven", other failures go back to the inbox.

Git and publishing

- `./git.ts` builds the clone, checkout, commit, fetch and push scripts the platform runs in a session sandbox.
- `./git-flags.ts` holds the git flags every platform git runs with; kept apart so the sandbox providers the runner bundles can import it.
- `./private-git.py` runs in the session container and bridges the agent's worktree to the platform-owned git directory.
- `./publish.ts` clones, pushes the session branch and opens or updates the pull request (`PullProblem`, `PublishEvidence`).
- `./checks.ts` names the verified check (`VERIFIED_NAME`) and the check-run update shape.

CI and features

- `./ci.ts` reads check runs, statuses and workflow logs into a `CiReading`, with `CI_POLLING` intervals and log tail limits.
- `./ci-base.ts` compares failed runs against the base branch's results.
- `./ci-history.ts` scans recent default-branch commits for CI evidence (repository readiness).
- `./setup-checks.ts` scans a repository's workflows and setup sources for readiness findings.
- `./feature.ts` creates and advances feature and subtask branches, merges reviewed pulls and opens the feature pull request.
- `./feature-ci.ts` decides whether pushes to a branch run CI and admits a repository for features.
- `./integration.ts` dispatches and follows a cross-repo feature's integration workflow run.

## Key types

- `GithubError` (`./app.ts`) carries the HTTP `status`, GitHub's message and headers. Callers branch on `status`, never on message text.
- `GithubProblem` (`./problem.ts`) is what reaches the user; `./repos.ts` re-exports it and `problemOf` maps a `GithubError` to one.
- `Delivery` (`./events.ts`) is the trimmed, authenticated event an actor receives, with the delivery GUID and receipt time.
- `StoredConnection` (`./repos.ts`) is the user's connection as the `user` actor stores it; `ConfirmedConnection` comes from `./state.ts`.
- `GithubId` comes from `server/src/contract.ts`: a GitHub ID as a canonical decimal string.

## Invariants and pitfalls

- Read signed payloads as raw bytes before decoding. Use `parseGithubJson` so a large repository or installation ID survives parsing.
- Request each installation token for one repository and only the permissions the step needs. Only read-only tokens are reused.
- Pass every GitHub or git error text through `redact` before logging or showing it.
- Platform git must use `SAFE_FLAGS`/`TRANSPORT_FLAGS`: no hooks, fsmonitor, submodule recursion or non-HTTP transport from repository config.
- For a new event, change `edge` and the receiving actor together. Keep the delivery GUID through dispatch so redelivery is recognized.
- Deliveries for installations not linked in `githubHooks` are answered `202` and dropped; installation events always reach the inbox.
- The App's own completed checks must not wake an item. Only a `rerequested` run of the `VERIFIED_NAME` check passes through `edge`.
- Webhook secrets rotate: `server/src/config.ts` accepts `WLP_GITHUB_WEBHOOK_SECRET` and `WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS`.

## See also

[Installation inbox](../actors/github-inbox.ts) admits and queues deliveries. [Intake](../actors/github-intake.ts) and [issue items](../actors/github-item.ts) file work from issues.
[GitHub stand-in](../../../scripts/github-standin.ts) serves the checks.
