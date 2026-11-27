# Credentials

What pays for a user's model requests, kept sealed in the user's actor. A turn pins a `CredentialRef`
(`server/src/contract/account.ts`): a saved Settings key, or with `plan` a connected subscription plan.
Neither reaches a sandbox: the platform model relay opens the secret for one request (docs/model-relay.md).

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx --test ../scripts/model-plans-check.ts` checks plan connect, refusal, sealing, generations and `WLP_PLAN_USERS`.
- `cd server && npx tsx --test --test-name-pattern="keep keys sealed" ../scripts/model-providers-check.ts` checks Settings keys.

## Module map

- `./index.ts` holds `CREDENTIAL_TABLES` and `credentialActions`: plan actions for the web and the internal lookups the relay and turns use (`internalCredential`, `internalCredentialGeneration`).
- `./keys.ts` stores Settings keys (`model_provider`), checks them by listing the provider's models, and serves their status.
- `./plans.ts` stores connected plans (`model_plan`). A Claude plan is the token `claude setup-token` prints, checked against Anthropic's profile endpoint.
- `./connect-code.ts` makes the one-time `wl_` codes the connect command carries; `server/src/actors/connect-codes.ts` keeps their digests, `server/src/connect-route.ts` redeems them.
- `./transit.ts` seals a secret for one relay request, bound to user, credential and request nonce, for a minute.

## Invariants and pitfalls

- Seal before anything crosses the Rivet engine: a token is sealed under `transit` between the connect route and the actor, and under `model-plan` at rest.
- A new connect replaces the generation, so every lease of the old token ends at its next request.
- `WLP_PLAN_USERS` unset turns plans off at once: no codes, no connect, and `savedPlan`/`planGeneration` answer null.
- Answers from the provider can echo the token. Read only the fields you need, and never log a body.
