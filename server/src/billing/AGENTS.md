# Billing

Plans, hosted-minute metering, the spend cap and the payment provider. With `WLP_BILLING_PROVIDER` unset, billing is off and every account has the deployment's limits.

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx ../scripts/billing-check.ts` runs every billing case in one process against `scripts/dodo-fake.ts` and in-memory SQLite. No server or network.
- `cd server && WLP_CHECK_SECTIONS=exempt npx tsx ../scripts/billing-check.ts` runs only the exempt-account admission and overage regression. Here the variable is compared exactly, not as a prefix.

The check is in the `rules` group of `scripts/ci-groups.json` (key `billing`). [Billing](../../../docs/billing.md) describes operator settings.

## Key files

- `./config.ts` reads the billing and Dodo environment variables listed in its header (`readBillingConfig`, cached by `billing`). `billing(uid)` returns null for exempt users. `BILLING_UID` is the uid shape a webhook may name.
- `./provider.ts` is the provider interface (`BillingProvider`, `BillingEvent`, `UsageReport`, `BillingProviderError`). Nothing outside the adapter knows which provider is in use.
- `./dodo.ts` is the one adapter (`DodoProvider`). It covers checkout, customers, portal, webhook mapping and usage events. Its header cites the Dodo API pages it follows.
- `./standard-webhooks.ts` signs and verifies Standard Webhooks signatures over the raw body, with a five-minute tolerance.
- `./route.ts` serves `POST /billing/webhook` (`BILLING_WEBHOOK_PATH`, wired in `server/src/index.ts`). It verifies the request, resolves the owner and hands each event to that account's `user` actor.
- `./customer-index.ts` is the service-only `billingCustomers` actor. It maps provider customer ids to uids, and a claimed customer never changes owner.
- `./account.ts` keeps one account's billing tables inside the `user` actor (`BILLING_TABLES`). It applies events, sets the cap, opens checkouts (`AccountCheckout`) and reports overage.
- `./plans.ts` defines `PLANS`, `BillingState`, `effectivePlan` and the cap and overage arithmetic.
- `./meter.ts` covers hosted-minute weights (`SIZE_WEIGHT`) and meter periods (`meterPeriod`, `shiftMonths`).

Callers: [user usage actions](../actors/user/usage.ts) (checkout, cap, webhook apply, overage retry), [`effectiveUserLimits`](../user-limits.ts) (operator override, then plan, then deployment) and `server/src/registry.ts`.

## Non-obvious patterns

- Webhooks apply once. `applyBillingEvent` writes the delivery id in the same transaction as the change. Duplicates and events older than the last applied one return `duplicate` or `stale` and change nothing.
- The route answers 2xx once each event has been applied, ignored or found not ours, and 5xx only when an actor is unreachable, so the provider retries. Log only ids and types, never the payload.
- `webhookOwner` drops an event whose customer index owner and metadata uid disagree.
- Overage goes out in whole minutes, capped by the spend cap, and only while a subscription runs (active or in grace). Free and yearly Pro never report overage. It is first stored as `pending` under one event id and resent under that same id, so the provider deduplicates it.
- `AccountCheckout` shares one in-flight provider call per actor. It re-reads state after the provider answers, because a webhook may have changed the subscription meanwhile.
- `CheckoutBlocked` and `CheckoutEmailRequired` carry user-facing messages. The user actor maps them to `UserError` codes `bad_input` and `already_subscribed`.
- Falling back to Free deletes nothing. It only limits what can start next.
- The web app imports `./meter.ts` (`SIZE_WEIGHT`, `shiftMonths`), so keep it and its type-only import of `./plans.ts` browser-safe.
