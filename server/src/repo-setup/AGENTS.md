# Repository setup

A setup turn drafts `AGENTS.md` guides and skills for a user's repository. This code validates that filing against the repository tree, has a second turn review it and publishes it as a pull request. It also hosts the guide checker that this repository's own guides use.

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx --test ../scripts/readiness-check.ts` runs the readiness, filing, guide-check, review and notes tests. It is a `node:test` file.
- `cd server && npx tsx --test --test-name-pattern='guide minimums' ../scripts/readiness-check.ts` narrows to one test by name.
- `node scripts/agents-docs-check.ts` runs `./guide-check.ts` over this repository's guides.

The check is the `repo-setup` key of the `rules` group in `scripts/ci-groups.json`. `FACTORY_ONLY=repo-setup` in `scripts/factory-e2e.ts` covers the actor flow in CI.

## Key files

- `./guide-check.ts` defines `checkGuide`, `guideTree`, `isGuide` and `skillPath`. Paths in backticks, links and prose must exist, and command lines are replayed for `cd`, package scripts, `npx` bins and file targets. `scripts/agents-docs-check.ts` and setup filing both use it.
- `./guide-structure.ts` requires `## Quick commands` and `## Key files` in filed guides, with a minimum line count based on how many source files a folder has. It applies only to customer filings, not to this repository's check.
- `./source-path.ts` holds `isSetupSource`, the source and generated-file patterns. `server/src/github/setup-checks.ts` uses it too.
- `./workflow-commands.ts` reads only the `run` field of each job step in a workflow, to supply command evidence.
- `./filing.ts` holds `validateDraft`, which checks the agent's filing tool arguments (files, notes, citations, limits, redaction) and returns `AcceptedDraft`. It also holds `privateLine`, `safeTarget` and `smokeCommand`.
- `./publish.ts` covers `checkSetupFiling`, which scans the repository at the pinned commit, validates and smoke-tests skills, and `publishSetup`, which pushes a dated setup branch and opens or updates the pull request.
- `./review.ts` runs the reviewer turn (`reviewSetup`, `REVIEW_MS`) and reconciles its verdicts with the revision (`reconcileReview`).
- `./phase.ts` holds `SetupPhase`, which tracks draft, review and revision state and builds the `SetupDiagnosis`.
- `./notes.ts` holds the owner's sealed setup notes and the last publication, in the user actor's SQLite (`NOTES_TABLE`, `PUBLICATION_TABLE`, 30-day `NOTE_LIFETIME`).
- `./freshness.ts` posts the guides check run (`GUIDE_CHECK`) when the repository enables it, rerunning `checkGuide` against the GitHub tree.
- `./types.ts` defines `SkillFiling`, `SetupDiagnosis`, `DraftRequest`, `SetupNote`, `NoteDecision` and `SetupPublication`.

Callers: `server/src/actors/agent-session.ts` (the setup turn), `server/src/actors/user.ts` (notes), `server/src/actors/github-repository.ts` (freshness) and `server/src/factory/readiness-filing.ts` (structure).

## Non-obvious patterns

- Changing `./guide-check.ts` changes two things: customer setup filings and the documentation check in this repository's CI. Run both quick commands above.
- Submitted commands are never executed during validation. Only path-existence checks replay against the trusted tree. A skill's smoke check is the single `test -f|-e|-d <path>` or `ls -- <path>` line under its `## Check` heading (`smokeCommand`), run in the sandbox with a 3-second timeout.
- A guide with an unsupported line is refused whole, and the agent must file it again. Skills that fail their smoke check are dropped instead.
- A filing is pinned to the scanned commit. If the repository moved, `checkSetupFiling` fails rather than validating against a different tree.
- `privateLine` refuses lines with saved secret values, credential-like text, home directories, email addresses or IP addresses. Notes are stored sealed.
