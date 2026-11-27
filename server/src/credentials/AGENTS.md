# Credentials

What pays for a user's model requests, kept sealed in the user's actor. A turn pins a `CredentialRef`
(`server/src/contract/account.ts`): a saved Settings key, or with `plan` a connected subscription plan.
A key never reaches a sandbox: the platform model relay opens the secret for one request (docs/model-relay.md).
On E2B and Daytona a plan's token is opened once per turn and handed on stdin to a relay inside the sandbox
that runs as another user than the agent's (`openSavedCredential` in `./transit.ts`, `server/src/sandbox/plan-relay.ts`).

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx --test ../scripts/model-plans-check.ts` checks plan connect, refusal, sealing, generations, `WLP_PLAN_USERS` and the connect request lifecycle.
- `cd server && npx tsx --test --test-name-pattern="keep keys sealed" ../scripts/model-providers-check.ts` checks Settings keys.

## Module map

- `./index.ts` holds `CREDENTIAL_TABLES` and `credentialActions`: plan actions for the web and the internal lookups the relay and turns use (`internalCredential`, `internalCredentialGeneration`).
- `./keys.ts` stores Settings keys (`model_provider`), checks them by listing the provider's models, and serves their status.
- `./plans.ts` stores connected plans (`model_plan`). A Claude plan is the token `claude setup-token` prints, checked against Anthropic's profile endpoint.
- `./connect-code.ts` makes a connect request's two secrets: the user code the terminal shows and the page approves, and the request secret only the terminal holds. `server/src/actors/connect-codes.ts` keeps their digests and each request's state; `server/src/connect-route.ts` serves the command (`cli/`).
- `./transit.ts` seals a secret for one relay request, bound to user, credential and request nonce, for a minute; `openSavedCredential` opens it at a pinned generation.

## Invariants and pitfalls

- Seal before anything crosses the Rivet engine: a token is sealed under `transit` between the connect route and the actor, and under `model-plan` at rest.
- A new connect replaces the generation, so every lease of the old token ends at its next request.
- `WLP_PLAN_USERS` unset turns plans off at once: no requests, no approving, no connect, and `savedPlan`/`planGeneration` answer null.
- A connect request is taken once, and only after its user approved it (`approvePlanConnect`). A wrong code counts against the user who typed it, so a signed-in stranger cannot guess a live code and receive someone else's token.
- Answers from the provider can echo the token. Read only the fields you need, and never log a body.
