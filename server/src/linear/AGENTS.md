# Linear integration

The app connects a workspace and turns qualifying team issue events into work items.

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx ../scripts/linear-protocol-check.ts` checks OAuth, GraphQL and webhook parsing against the stand-in.
- `cd server && LINEAR_ONLY=OAuth npx tsx ../scripts/linear-check.ts` checks the connection and ticket.
- `cd server && LINEAR_ONLY=setup npx tsx ../scripts/linear-check.ts` checks disconnected intake.

## Key files

- `app.ts` implements the OAuth and GraphQL client, including issue reads and writebacks.
- `connect.ts` consumes OAuth state, exchanges the code using PKCE and seals the connection ticket.
- `webhook.ts` verifies the raw signature and signed timestamp, then classifies issue transitions.
- [User integration](../actors/user-linear.ts) stores the owner's connection and team mappings.

## Non-obvious patterns

- Classify updates using the previous field values. An unrelated edit to an already labelled issue must not file another item.
- The mapping and filing checks depend on state created by earlier cases. Use the standalone filters above locally and leave the sequence to CI.
- Pass lookup IDs through admission. The owner's intake re-reads the issue and checks the current mapping and qualification before filing.
- OAuth identifies the app user. Treat issue text as third-party input even when the delivery names the person who added the label.

## See also

[Workspace actor](../actors/linear-workspace.ts) locates the team owner. [Shared intake](../actors/issue-intake.ts) files the item.
