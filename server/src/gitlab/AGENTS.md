# GitLab integration

## Quick commands

Run from the repository root. These checks use the [GitLab stand-in](../../../scripts/gitlab-standin.ts), not a live account.

- `cd server && npx tsx ../scripts/gitlab-protocol-check.ts` checks the adapter against the GitLab API fixture.
- `cd server && npx tsx ../scripts/gitlab-check.ts connect` checks OAuth, project selection and hook registration.
- `cd server && npx tsx ../scripts/gitlab-check.ts intake refuse untrusted` checks the issue-to-merge path, rejected deliveries and third-party text.

## Key files

- [Host adapter](./host.ts) handles merge requests, pipeline jobs, notes and reactions. Keep GitLab IDs as decimal strings.
- [Webhook parser](./webhook.ts) verifies the project token and classifies events. [Issue intake](../actors/issue-intake.ts) re-reads the issue and command note before filing.
- [User connection](../actors/user-gitlab.ts) owns OAuth credentials, the selected project and its hook secret.
