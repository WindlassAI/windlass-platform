# GitHub integration

This layer connects installations, publishes session work and admits signed GitHub events.

## Quick commands

Run one command from the repository root.

- `cd server && WLP_CHECK_SECTIONS=connect npx tsx ../scripts/github-check.ts` checks installation linking.
- `cd server && WLP_CHECK_SECTIONS=publish npx tsx ../scripts/github-check.ts` checks publishing.
- `cd server && WEBHOOK_ONLY='G3 feature' npx tsx ../scripts/webhook-check.ts` selects feature filing cases.

## Key files

- `app.ts` handles App authentication and GitHub API requests.
- `publish.ts` coordinates repository clone, branch push and pull request creation.
- `webhook.ts` authenticates incoming deliveries and routes them to actors.
- `events.ts` normalizes supported events into the fields needed downstream.
- `ids.ts` preserves numeric GitHub IDs as decimal strings.

## Non-obvious patterns

- Read signed payloads as raw bytes before decoding. Use the GitHub JSON reader so a large repository or installation ID survives parsing.
- For a new event, change the edge parser and the receiving actor together. Keep the delivery GUID through dispatch so redelivery can be recognized.
- The App's own completed checks must not wake an item. Its explicitly rerequested verification check has a separate path.

## See also

[Installation inbox](../actors/github-inbox.ts) admits and queues deliveries. [GitHub stand-in](../../../scripts/github-standin.ts) serves the checks.
