# Credentials

What pays for a user's model requests, kept sealed in the user's actor. A turn pins a `CredentialRef`
(`server/src/contract/account.ts`): a saved Settings key, or with `plan` a connected subscription plan.
A key never reaches a sandbox: the platform model relay opens the secret for one request (docs/model-relay.md).
On E2B and Daytona a plan's token is opened at the turn's start and handed on stdin to a relay inside the sandbox
that runs as another user than the agent's (`openSavedCredential` in `./transit.ts`, `server/src/sandbox/plan-relay.ts`);
an expiring one (a ChatGPT plan's) is handed again before it runs out (`rotatePlanToken` in `server/src/sandbox/token-file.ts`).

Plans, one `model_plan` row each:

- `anthropic`, the Claude plan: the token `claude setup-token` prints, sealed here. Hosted Claude Code pays with it.
- `openai`, the ChatGPT plan: the user's ChatGPT sign-in. Windlass's unqualified models run on it for everyone, as
  before; hosted Codex pays with it where `WLP_PLAN_USERS` allows. Its `sealed` and `short_noted` columns belong to
  the user actor's `SignInHolder` (`server/src/signin/holder.ts`), which alone opens it, refreshes it one at a time
  and keeps the refresh token. It is connected with the CLI's `connect codex` (`cli/`): Windlass signs in on the
  user's computer and the command uploads its files (`SignInUpload`), which the holder adopts under a new generation. A relay asks for its current access token (the `token` of a `ChatgptPlan`, `./index.ts`).

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx --test ../scripts/model-plans-check.ts` checks plan connect, refusal, sealing, generations, `WLP_PLAN_USERS`, the ChatGPT plan (its token per request, connecting it with an uploaded sign-in, the `signin` table's copy), plan models and names, and the connect request lifecycle.
- `cd server && npx tsx --test --test-name-pattern="keep keys sealed" ../scripts/model-providers-check.ts` checks Settings keys.

## Module map

- `./index.ts` holds `CREDENTIAL_TABLES` and `credentialActions`: plan actions for the web and the internal lookups the relay and turns use (`internalCredential`, `internalCredentialGeneration`, `internalPlanModels`). The ChatGPT plan comes in as a `ChatgptPlan` from `server/src/actors/user/signin.ts`.
- `./keys.ts` stores Settings keys (`model_provider`), checks them by listing the provider's models, and serves their status.
- `./plans.ts` stores connected plans (`model_plan`): a Claude plan checked against Anthropic's profile endpoint, the ChatGPT plan's row as the holder writes it (`writeChatgptSignIn`), each plan's models (ChatGPT's catalog, or what Claude Code reported at a plan-paid session's start), and the one-time copy of the old `signin` table (`moveSignInToPlan`).
- `./plan-labels.ts` turns a provider's tier name into the plan's label ("a@b.com · Max"); an unknown one is shown title-cased.
- `./connect-code.ts` makes a connect request's two secrets: the user code the terminal shows and the page approves, and the request secret only the terminal holds. `server/src/actors/connect-codes.ts` keeps their digests and each request's state; `server/src/connect-route.ts` serves the command (`cli/`).
- `./transit.ts` seals a secret for one relay request, bound to user, credential and request nonce, for a minute; `openSavedCredential` opens it at a pinned generation.

## Invariants and pitfalls

- Seal before anything crosses the Rivet engine: a token is sealed under `transit` between the connect route and the actor, and under `model-plan` at rest.
- A new connect replaces the generation, so every lease of the old token ends at its next request. A refresh of the ChatGPT plan never changes it.
- `WLP_PLAN_USERS` unset turns plans off at once: no Claude plan requests, approving or connect, and `savedPlan`/`planGeneration` answer null. The ChatGPT sign-in stays Windlass's for everyone, so any signed-in (non-demo) user may connect it with the command; only paying for hosted Codex with it is gated.
- Approving names the plan (`approvePlanConnect(code, provider)`, from the page's `plan`): a code for another plan approves nothing. An upload that is not a finished sign-in (`uploadedSignIn`) is refused before the request is taken.
- A plan's models are never hard-coded: without a report a plan offers only the agent's default.
- A connect request is taken once, and only after its user approved it (`approvePlanConnect`). A wrong code counts against the user who typed it, so a signed-in stranger cannot guess a live code and receive someone else's token.
- Answers from the provider can echo the token. Read only the fields you need, and never log a body.
