# Repository setup

Finish setup turns repository evidence and selected owner notes into reviewed guides and skills for a pull request.

## Quick commands

Run this case from the repository root to check how review selects files and retains their citations.

```sh
cd server && npx tsx --test --test-name-pattern='reconcile each reviewed guide' ../scripts/readiness-check.ts
```

## Key files

- `./filing.ts` validates the readiness score, draft files, line citations and note decisions.
- `./guide-check.ts` resolves guide references and checks paths and commands against the repository tree.
- `./guide-structure.ts` checks required sections, key file entries and guide length.
- `./source-path.ts` identifies the source files that count toward guide length.
- `./workflow-commands.ts` extracts commands and line numbers from workflow run steps for citation checks.
- `./review.ts` runs the independent review and reconciles its verdicts with the original and revised filings.
- `./publish.ts` checks filings against the pinned checkout and publishes accepted files to a setup pull request.
- `./notes.ts` seals owner notes, stores filing decisions and tracks the setup pull request.
- `./phase.ts` tracks draft, review and revision turns and records redacted diagnostics.
- `./freshness.ts` posts the GitHub guide check when enabled.
- `./types.ts` defines draft requests, note decisions, diagnostics and publication records.

## Finish setup flow

1. [The factory prompt](../factory/readiness-filing.ts) asks the agent to call `file_repo_setup` with its score, proposed files, citations and a decision for each selected note.
2. [The session actor](../actors/agent-session.ts) calls `reviewSetup` to run the draft turn. Its filing handler uses `checkSetupFiling` to gather checkout evidence for `validateDraft`.
3. A separate read-only turn calls `file_repo_setup_review` with an ok, fix or drop verdict per file. A fix triggers one revision. Reconciliation keeps approved originals and accepted fixes with their corresponding citations.
4. If any files survive review, the session calls `publishSetup` to write them to the work branch and open or update the setup pull request.
