# Checks and CI selection

Most checks are standalone programs. Use the changed source path to find the check that exercises it.

## Quick commands

Run one command from the repository root.

- `node scripts/agents-docs-check.ts` validates file references and command targets in agent guides.
- `node scripts/ci-heavy.mjs select --files server/src/github/events.ts` prints the matching CI groups.
- `node scripts/workflow-lint.ts .github/workflows/ci.yml` checks one workflow's permissions and action pins.

## Key files

- `./ci-groups.json` maps source paths to heavy checks, shard arguments, environments and images.
- `./ci-heavy.mjs` selects jobs from that map and runs their commands in the server workspace.
- `./agents-docs-check.ts` checks paths from the repository root, explicit `./` and `../` paths from the guide, and commands from their working directory.
- `./workflow-lint.ts` checks Actions permissions and requires actions pinned by commit.

## Non-obvious patterns

- When adding a heavy check, list the check file and the source paths that should select it. Unmatched paths select no heavy job.
- Run TypeScript checks from the server workspace so they use its tsx. Match the invocation in the group's checks.
- For agent guides, use Markdown links or backticks for paths. Start each command example at the repository root and show any directory change.

## See also

[Testing](../docs/testing.md) lists prerequisites. [Light CI](../.github/workflows/ci.yml) runs the documentation check and typechecks.
