# Plans and billing

A deployment can take payment for plans. Billing is **off** unless `WLP_BILLING_PROVIDER` is set. With it off,
nothing changes: there are no plans, every account has the deployment's limits ([configuration.md](configuration.md#usage-limits)),
and no page shows anything about billing. A self-hosted deployment needs none of this.

## The plans

| | Free | Pro |
|---|---|---|
| Price | $0 | $15 a month, or $144 a year |
| Paired machines | 3 (runs on them unlimited) | 10 |
| Hosted minutes a month | 120 | 1,800 |
| Hosted at once (`hostedRunning`) | 1 | 5 |
| Kept hosted sandboxes (`maxKept`) | 2 | 10 |
| Sizes | small, standard | small, standard, large |
| Features over two repositories | no | yes |
| Items filed from GitHub a day | 20 | 100 |
| Past the included minutes | hard stop | $0.006 a minute, up to the spend cap (default and most $20 a month) |

The plans live in `server/src/billing/plans.ts`. Team and Enterprise are not built. They would be more `PlanId`s, with their
limits pooled over an org's seats.

**Precedence.** An operator's override of one user's limit (`set-user-limit.ts`) wins. Otherwise the plan's figure
applies, and otherwise the deployment's default. With a plan, the **monthly** hosted minutes replace the **daily**
allowance (`WLP_DAILY_SANDBOX_SECONDS`), unless an operator set `dailySeconds` for that user. One allowance is easier to
explain and to price. The daily one stays exactly as it was wherever billing is off.

**Which plan applies** is decided at each step from the subscription and the clock. An active subscription means Pro. So
does a past-due one within the grace period (`WLP_BILLING_GRACE_DAYS`, 7). Otherwise the account is on Free. Falling
back to Free deletes nothing: kept sandboxes, machines and items stay, and only what starts next is held to Free's limits.

## Hosted minutes

- **The unit.** One hosted minute is one minute of a standard sandbox (2 vCPU, 4 GiB). Small counts 0.5 and large counts 2.
- **What is counted.** The minutes are counted from the same ledger as sandbox time (`server/src/usage.ts`). Each entry is weighted by its session's size (`server/src/billing/meter.ts`, `sessionSize`).
- **The size** is the session's `hostedSize`. A session from before sizes has none and counts as small, the size it ran at. On Free, large is not offered: a launch that asks for it is refused, and a saved default of large steps down to standard.
- **Months** are UTC calendar months. A hold never reaches past midnight UTC, so the first hold of a month is the new month's.
- **Machines are not metered.** Runs on users' own machines never enter the ledger.

**The cap is enforced on the server.** The user actor will not give a hold past the month's limit. On Free that limit is
the included minutes. On Pro it is the included minutes plus what the spend cap pays for. A running turn is stopped
when the hold it has is over, with its files kept, the same as at the daily allowance.

## Payment provider

The provider sits behind `BillingProvider` (`server/src/billing/provider.ts`). Plans, the meter, limits, the cap, grace
and the screens do not know which provider is used. Dodo Payments is the one adapter (`server/src/billing/dodo.ts`, which
cites the Dodo docs it follows).

### What to create in the Dodo dashboard

Do this in **test mode** first. The API key, products and webhook are separate in live mode.

1. **API key.** Developer → API Keys → create one. It starts `dodo_test_`. This is `WLP_DODO_API_KEY`.
2. **Overage meter.** Products → Meters → Create Meter:
   - **Event Name** `hosted_minutes`. If you choose another name, set it as `WLP_DODO_METER_EVENT`. The event name cannot be changed later.
   - **Aggregation Type** Sum, **Over Property** `minutes`.
   - **Measurement Unit** `hosted minutes`.
   - No event filter.
3. **Pro, monthly.** Products → Create product, of type subscription:
   - $15.00 USD, billed every 1 month.
   - Under **Usage Based Billing** → **Associated Meters**, add the meter with **Price Per Unit** $0.006 and **Free Threshold** 0. The platform reports only minutes past the included ones, so the threshold must stay 0.
   - Its id (`pdt_…`) is `WLP_DODO_PRODUCT_PRO_MONTHLY`.
4. **Pro, yearly.** The same product at $144.00 USD, billed every 1 year, with the same meter at $0.006 and threshold 0. Its id is `WLP_DODO_PRODUCT_PRO_YEARLY`.
5. **Customer portal.** Settings → Customer Portal: allow cancelling and updating the payment method. Each portal session sets its own return address.
6. **Webhook.** Developer → Webhooks → Add endpoint:
   - URL `https://<your public address>/billing/webhook`.
   - Subscribe to:
     - `subscription.active`, `subscription.renewed`, `subscription.updated`, `subscription.plan_changed`
     - `subscription.on_hold`, `subscription.past_due`
     - `subscription.cancelled`, `subscription.expired`, `subscription.failed`
     - `subscription.paused`, `subscription.unpaused`
     - `payment.failed`
   - Its signing secret (`whsec_…`, on the endpoint's Overview) is `WLP_DODO_WEBHOOK_SECRET`.

### Turning it on

```sh
WLP_BILLING_PROVIDER=dodo
WLP_DODO_ENVIRONMENT=test_mode          # live_mode only with live keys and live products
WLP_DODO_API_KEY=...                    # secret
WLP_DODO_WEBHOOK_SECRET=whsec_...       # secret
WLP_DODO_PRODUCT_PRO_MONTHLY=pdt_...
WLP_DODO_PRODUCT_PRO_YEARLY=pdt_...
# WLP_DODO_METER_EVENT=hosted_minutes
# WLP_BILLING_GRACE_DAYS=7
```

- **The web origin.** Checkout and the portal return to the web app's own address. It must be in `WLP_ORIGINS`, or the server refuses with `origin_not_allowed`.
- **A missing setting** stops the server at start. The message names the setting, never its value.
- **The start log** says `billing: dodo; webhooks to /billing/webhook`, or `billing: off`.

### How the money code behaves

- **Webhooks.**
  - **Verified first.** Signatures are checked by the Standard Webhooks spec: `webhook-id`, `webhook-timestamp` and `webhook-signature`, HMAC-SHA256, five minutes of tolerance. A delivery that fails gets 401.
  - **Routed by account.** The account comes from the `wlp_uid` metadata the checkout sets. A delivery naming no account of this deployment is logged (`billing.unmatched`) and answered 200.
  - **Applied once.** Each delivery is applied once: its id is written in the same transaction as the change. An older event that arrives late changes nothing.
  - **Mismatches are logged and ignored.** This covers another customer's event, and a second subscription while one runs. Refund such a second subscription by hand.
  - **Retries.** 5xx means "send it again"; Dodo retries with backoff for about a day and a half.
- **Event mapping.**

  | Dodo event | What it does |
  |---|---|
  | `subscription.active`, `.renewed`, `.unpaused` | Pro, active |
  | `subscription.updated`, `.plan_changed` | changed, mapped by the status it carries |
  | `subscription.on_hold`, `.past_due`, `payment.failed` | payment failed; the grace period starts |
  | `subscription.cancelled`, `.expired`, `.failed`, `.paused` | ended; Free from now |

  Subscriptions to other products of the same Dodo account are ignored.
- **Overage.**
  - **Only while a subscription runs** (active, or in grace) with a customer and a subscription id. Never on Free.
  - **Whole minutes,** rounded down, and never more than the cap pays for.
  - **Recorded before it is sent.** The minutes not yet reported are written down as pending under one `event_id`, then sent to `POST /events/ingest`. They are sent again under the same id until Dodo takes them; Dodo ignores an `event_id` it has already seen. Last month's remainder is reported in the first days of the next.
  - **The log line** is `billing.usage_reported`.
- **Logs** carry ids only: account, customer, subscription, delivery and event. They never carry names, emails, cards or addresses, and never the provider's own error text.

### Checks

`scripts/billing-check.ts` runs the plans, the meter, the monthly rollover, the cap, grace and downgrade, the webhooks and
the reports against a fake Dodo (`scripts/dodo-fake.ts`, shaped on Dodo's documented payloads). It makes no network
calls. It runs in CI with the rules group. `scripts/usage-check.ts` holds that billing off behaves as before.
