# Work items

How the Factory carries a work item from the task to a pull request, and what a deployment sets for it. What
users see and do is in the in-app docs ([The Factory](../web/src/docs/content/factory.md)); this file is the
implementation and the operator's settings.

A work item is a task on one repository of the user's GitHub connection that the platform carries from the
start to a pull request by itself: a title, a description, and acceptance criteria, which are for the
person to check and which the verdict lists. Each item has an agent session of its own, listed with the
user's other agents, that only the item's steps send prompts to ("This agent works for a work item, whose
steps send its prompts. Answer the item, or send its work back with a note.") and that cannot be deleted
while the item has it; the item is cancelled instead, and the agent and what it did stay readable. An
item is filed from the Factory page, on its repository's Work view ("New work item…"), from a GitHub issue
(where the deployment has a webhook) or through the API below, and has a page
of its own (`/items/<id>`) with its step, its log, its verdicts and its cost. The home screen lists, under
"Needs you", every item that asks its person something.

## Turning work items on

Work items are off unless the deployment sets `WLP_ITEMS=1`. Off, the web app shows nothing of them (no
work items on a repository's page, no "Needs you" for items, no API tokens on the Settings page, and an
item's page is not found), the `user` actor's item and API token actions (`listItems`, `item`,
`createItem`, `actOnItem`, `apiTokens`, `createApiToken`, `revokeApiToken`) refuse with `items_off`
("Work items are not available on this platform."), `/api/items` answers 404, `not_found`, before any
token is read, and platform info has no `items`. Two things are not switched: `factoryLimits` answers
either way, since `WLP_FACTORY_RUNNING_TURNS` is also the ceiling on a person's own running agents
([Usage and limits](architecture.md#usage-and-limits)); and the `workItem` actors and their tables stay, so an item that exists goes on
with its steps while the switch is off, and turning it off and on again loses nothing. While it is off,
nobody can file, read or act on an item.

## Where an item runs

An item runs on a hosted sandbox by default. With `WLP_MACHINES=1`, it can run on a machine paired
to the same account. Send `"place": {"kind": "machine", "machineId": "…"}` with the item. Its session
uses the requested `profile` if the machine offers it, otherwise the first available profile in its
last report. The runner must have reported an available profile at least once. When a turn is due
and the machine is offline or does not answer, the item waits without spending its budget and resumes
when the runner answers. Removing the machine stops outstanding work and asks the person to give up
or hand over the commit the run already pushed.

## How an item runs

- **The sequence is fixed** (`server/src/factory/blueprint.ts`). Which step comes next is decided from what
  the platform observed, never from what the agent says. The agent implements the task in one turn. The
  turn's own verification, the user's checks for the repository ([A repository's checks](github-and-repositories.md#a-repositorys-checks)), decides what
  follows: a check that failed sends the agent back to fix it, at most twice in a run. Then the platform
  pushes the item's branch and opens the pull request; a push that does not get through for a network
  error is tried three times, and one GitHub refuses is a question with GitHub's reason. It waits for CI with
  the sandbox paused, reading it every minute, or every three minutes while the user has more than ten
  items open; no check run and no status ten minutes after the push means the repository has no CI. It
  gives the agent CI's failing checks and the end of their logs, at most twice in a run. A pull request
  that GitHub says conflicts with its base gets one turn to merge the base. Then the item is handed to its
  person with a verdict and is in review, and the platform reads the pull request every ten minutes until
  it is merged (the item is done) or closed (cancelled).
- **The handoff on GitHub.** When an item is handed over, the platform asks the person for a review of
  the pull request, as the GitHub login of their connection, unless they are asked already, and posts the
  verdict in one comment: the verdict at the pushed commit, its sentence, and the acceptance criteria
  left to the person. The comment is the item's own (its first line is `<!-- windlass-item:<id> -->`), and
  each later handoff of the item edits it instead of adding another. A review request GitHub refuses is
  written in the item's log ("GitHub refused the review request (422).") and the comment is posted all the
  same; a request or a comment that does not get through otherwise is written there too ("Could not post
  the verdict comment (GitHub 502). The platform will try again.") and tried again later. Either way the
  item is in review: nothing on GitHub holds the handoff back. Both go through the app's installation,
  with a token for pull requests: write and metadata: read on that one repository, which the app's
  "Pull requests: read and write" covers.
- **The platform never merges.** Nothing in the sequence merges a pull request, and no verdict does: the
  app never approves, merges or dismisses a review. The person merges at GitHub, or sends the work back
  from the item's page with a note, which starts a new run.
- **Turns are unattended.** An item's turn has nobody to ask: a tool call that would ask is refused at once,
  and the model is told so. On a machine using `docker-hardened`, Windlass runs shell commands unasked
  inside the runner's container. There is no per-command sandbox. Those commands can reach the machine's
  local network and read the session's access token. A turn takes at most 60 steps. The agent is not given `publish`, since the
  platform opens an item's pull request itself; it is given `report`, to file what it did, in a title and a
  description that the platform puts on the pull request, and what it is unsure of, and `push` and
  `fetch_base` as a person's agent is ([The agent's own tools](github-and-repositories.md#the-agents-own-tools)): it may push the item's branch during its
  turn, and the item's publish step pushes whatever it did not. A turn in which the agent pushed counts as
  one that changed something.
- **Every stop is a question.** The rounds above used up, the same failure again after a fix, a turn that
  changed nothing, a push GitHub refused, CI still running 90 minutes after the push, a step whose turn was
  cut off three times (by a deploy or a restart), or the item's budget used up: the item waits for its
  person, for days if need be, with the reason and the choices that fit it ("Raise the limit and go on",
  "Retry from scratch", "Hand it over as it is" once there is a pull request, "Give up").
- **The verdict** is what the work at the pushed commit rests on, made from what the session's gate
  recorded, the observations on the changes ([What a pull request shows was verified](github-and-repositories.md#what-a-pull-request-shows-was-verified)) and CI at that
  commit, never from the agent's words (`server/src/factory/verdict.ts`). CI decides; the user's checks
  are optional. `fail`: a check of the gate's run or CI failed; `incomplete`: the turn was stopped, failed
  or was cut off; `pass`: CI passed on the pushed commit, or, CI not having passed, the user's own checks
  passed in the gate's run with nothing changed after them; `unverified`: nothing verified this state of
  the work (no CI, CI in which nothing passed, CI unfinished or unread, and no run of the user's checks
  behind it), or the pull request holds a commit pushed after the agent's. A pass with observations is
  shown as needing a look. A pass on the user's checks while CI was not read begins "Your checks passed;
  CI has not been read." ("…CI had not finished." while it ran), never "Ready for review." A pull request
  someone else pushed to is handed over as it is, not verified, and its verdict is made again when that
  happens after the handover.
- **Limits are waits.** Nothing is refused for lack of room. An item that cannot go on now waits and says
  for what, with its numbers ("Waiting for one of your 5 factory turns; 5 are running (…)."): a free turn,
  a free place among the kept sandboxes, the day's allowance (until 00:00 UTC), one of the user's hosted
  sandboxes running at once, the deployment's cap on running sandboxes, or fewer of the user's items in
  review, which holds back new work and never work in progress. A request is tried again when a turn is
  given back or one of the person's own agents goes idle, and otherwise after 30 seconds, then twice as long
  each time up to five minutes. Requests are taken oldest first, and an item has at most one turn
  waiting, so the items take turns.
- **The same ceiling as the person's own agents.** `WLP_FACTORY_RUNNING_TURNS` counts the person's own
  turns and the items' together, and is the ceiling on the person's own running agents ("Usage and
  limits"). The items' share, `WLP_FACTORY_TURNS`, is held at least one below it (unless the ceiling is
  1), so a person's own prompt never waits behind the factory. A machine item's turn uses this share
  and counts toward the person's running-turn ceiling. Hosted running, kept-sandbox and time caps apply
  only to hosted items. The machine enforces its runner's own caps.
- **The cost of an item** is its tokens, turns, working time and hosted sandbox time, against its budget, on
  the item's page and the usage page. A machine item has zero hosted seconds and has only the first three limits. Working time leaves out what it waited for. A budget used up is a
  question, and "Raise the limit and go on" takes the person's new figures for that item.

**CI needs the GitHub App's three read permissions** ([The GitHub App](operating.md#the-github-app)). Without them, or before an
installation has accepted them, an item waits for no CI: it is handed over saying that CI was not read.

An item's turn runs only in a sandbox whose Windlass takes host tools ("The agent's own
tools"). A single item starts by implementing; an
orchestrated one starts with a planner ([Feature orchestration](#feature-orchestration) above).

```sh
cd server && npx tsx ../scripts/factory-check.ts                          # the sequence, verdicts and budgets as tables of facts, and the reader of CI against the GitHub stand-in
cd server && npx tsx ../scripts/factory-e2e.ts                          # items through the real actors, on fake sandboxes and the GitHub stand-in
```

## Feature orchestration

**Plan first** is the default when orchestration is enabled. The web form, API filings without a mode,
and ordinary GitHub issue filings start with a plan for owner approval. Select **Quick** or send
`"mode": "single"` for one implementer. On GitHub, use the `windlass:quick` label or start the
command with `quick`. An issue labelled `bug` always runs Quick.

The planner reads the repository and proposes two to six subtasks with owned paths, dependencies,
acceptance checks and individual caps. The feature starts with three times the single-item allowance
in each dimension. Before each planner turn, the factory checks a cumulative planning allowance of
25% of one Quick item. Switching to one implementer keeps the planning spend on the ledger and
adds one Quick allowance for implementation, within the feature cap. Planning and children must leave four turns for the summary, review and a retry of each.
One sixth of the single-item tokens, active seconds and hosted seconds is also reserved, rounded up.
At the default limits that is 1M tokens, 40 active minutes and 20 hosted minutes. A feature budget
raise specifies new limits and can add at most one single-item allowance in each dimension per raise. Each subtask needs two turns for implementation and verification, and at least 10% of the single-item
tokens, active time and hosted time, with minimums of 1,000 tokens and 60 seconds of each time allowance.
Each dimension is capped at the single-item limit. The approval question shows
the proposed split. A client can answer plan questions or edit the split using `edit_plan` with the
displayed version. `approve_plan` requires that same version and answered questions. On
`item_conflict`, fetch the item again. A single-item suggestion needs an explicit choice.

Approval requires saved checks and evidence of push CI on the planned Windlass branches. It opens
a draft PR on `windlass/feature-<item-id>`. When GitHub refuses drafts, it opens an ordinary PR
whose description marks the feature as in progress. Each child starts from that branch and
has its own session. Passing local checks and passing CI on the child's pushed SHA let the platform
fast-forward the feature branch. Repositories using only pull-request workflows need a push or
external check for child commits. The preflight reads enabled Actions workflows and their branch filters. It also recognizes successful
external checks or statuses on a prior standalone Windlass push. A missing child check offers a wait
for late CI. Stopping there ends orchestration and offers handover of the last integrated head. Child questions appear
in Needs you with the feature name. A stopped child can prompt up to two revised plans, each requiring
approval. Cancel on the parent stops its children and keeps their branches. The final summary and
whole-feature review go on the one feature PR. The owner merges it.

The user action `setMachineDetails` accepts `machineId`, `whenToUse` and `tags`. The planner sees
this inventory and the available machine capacity. A subtask needs a ready, allowed placement at approval.
Current runners support one sandbox slot per subtask. At dispatch, a busy or offline destination can wait.
A removed or disallowed destination asks the owner to revise the placement, retry allowed places or give up the subtask.
Update the server before runners so it can read the optional host report. Older runners can keep serving
work. `WLP_FACTORY_ORCHESTRATE=0` hides the filing control and blocks new orchestrated filings.

## The second review

With `WLP_FACTORY_REVIEWER=on`, each new item on a hosted profile that isolates
individual commands gets a second session. After CI, the reviewer runs setup on
the pinned base in its own sandbox and checks out the exact pushed commit detached.
It reads the task, the platform's evidence and the builder's filed claims. The
builder's conversation stays in the builder's session. Setup receives only
setup-scoped repository secrets. Reviewer commands run without network, MCP
servers or saved secrets. Its sole platform tool, `file_review`, files findings,
command evidence, excerpts and screenshots. Both sessions count toward the item budget.

The review is advisory. Every recommendation hands the item to its owner, with a
summary in the pull request comment and the full filing on the item's page. A
repository’s `screenshots` setting defaults to false. Enable it to give new work item sandboxes a browser. Images require configured storage. The reviewer defaults
to off for new items unless the deployment enables it.

## Limits

The limits are the deployment's, the same for every user, set by its owner; a user cannot raise them. A
setting that is not a whole number in its range stops the server when it starts.

| Limit | Setting | Default |
|---|---|---|
| A user's turns running at once, their own and their items' together | `WLP_FACTORY_RUNNING_TURNS` | 6 (at most 100) |
| Of those, the items' | `WLP_FACTORY_TURNS` | 5; one set higher is held to one less than `WLP_FACTORY_RUNNING_TURNS`, and to 1 at least |
| The user's hosted sandboxes running at once beside which an item's turn may start | `WLP_FACTORY_HOSTED_RUNNING` | 3 |
| Items in review at which new items wait | `WLP_FACTORY_REVIEW_CAP` | 6 |
| A new item's budget: tokens, turns, working seconds, hosted sandbox seconds | `WLP_FACTORY_ITEM_TOKENS`, `WLP_FACTORY_ITEM_TURNS`, `WLP_FACTORY_ITEM_ACTIVE_SECONDS`, `WLP_FACTORY_ITEM_HOSTED_SECONDS` | 6,000,000 tokens, 14 turns, 14400 (4 hours), 7200 (2 hours) |

An item's hosted sandbox counts against the user's daily allowance and kept sandboxes as any other ("Usage
and limits"), whose defaults are sized for a few agents by hand, not for many items a day.

## The API

A script files and reads items with an API token, sent as `Authorization: Bearer wlp_…`. A user
makes one on their Settings page (`/settings`), under "API tokens", with one or both scopes,
`items:create` and `items:read`; its value is shown once, the platform keeps only its SHA-256 digest
(`server/src/api-tokens.ts`), and it works until it is revoked there. An account keeps at most 20.

```sh
curl -X POST https://<name>.onrivet.dev/api/items \
  -H "Authorization: Bearer $API_TOKEN" -H "Idempotency-Key: $(uuidgen)" -H "content-type: application/json" \
  -d '{"repository":{"id":123456789},"title":"Fix the light","body":"...","acceptance":["The light turns off"],"start":true}'
curl https://<name>.onrivet.dev/api/items/<id> -H "Authorization: Bearer $API_TOKEN"
```

`POST /api/items` takes what the web app's form sends (`CreateItemInput`): `repository.id` is GitHub's id
for a repository of the user's connection, `branch` beside it names the base (the default branch when left
out), and `start: true` starts the item at once; without it the item is a draft until it is started. It
answers 201 with the item's summary. `GET /api/items/<id>` answers 200 with the item's page (`ItemView`).
Clients that previously omitted `mode` to launch one implementer must now send `"mode": "single"`.
Omitting `mode` selects Plan first and waits for owner approval when orchestration is enabled.
With `WLP_FACTORY_ORCHESTRATE=0`, omission selects Quick.
The `Idempotency-Key` header is the creation's key, by the rules of [A message sent twice](architecture.md#a-message-sent-twice): the same key
with the same body answers with the item the first attempt made, and with another body it is refused (409,
`idempotency_key_reused`). Invalid or out-of-scope tokens receive 401, `invalid_token`, within the applicable rate limits.
Rate limits return 429 with `Retry-After`. Every error carries `{ code, message }`.
See [Public HTTP rate limits](operating.md#public-http-rate-limits). Without `WLP_ITEMS=1` both
routes answer 404, `not_found` ("There is no such route."), whatever the token.

## Screenshots on work items

Screenshots are off by default. Enable **Take screenshots for work items** in the repository’s
Settings tab. New builder and reviewer sandboxes then use `windlass-platform-sandbox:shots`
on Docker or `windlass-platform-sandbox-shots` on E2B. The shots image extends the base with
Chrome headless shell, Playwright core, fonts and `wlp-shot`. Personal agents and items with
screenshots off use `windlass-platform-sandbox:latest` or the `windlass-platform-sandbox` template.

Each turn reads the current setting. Turning it off stops new screenshot filings on the next turn.
Turning it on while an item runs leaves its builder in its original sandbox. A builder created
without a browser keeps working without screenshots. Each new review gets a fresh sandbox
chosen with the current setting. Previously filed pictures stay on the item.

A builder can file up to four PNGs saved by `wlp-shot` in its clone’s `.wlp-shots/` directory. The platform uploads a private copy directly from the sandbox to the configured backup bucket. Each upload link covers one object, its exact length and its PNG content type. The platform checks the stored length and the first 33 bytes. The sandbox receives the link on standard input. Storage credentials stay on the server.

The default limits are 2 MiB per screenshot (`WLP_FACTORY_ATTACHMENT_BYTES`), 40 screenshots per item (`WLP_FACTORY_ATTACHMENTS_PER_ITEM`) and 1 GiB per account (`WLP_FACTORY_ATTACHMENT_ACCOUNT_BYTES`). Images must fit within 3840 × 8640 and 16,600,000 pixels. Captions take one line of up to 200 characters, and the optional page label takes up to 300. Reservations count against both quotas. A daily sweep removes abandoned reservations older than two hours and screenshots of items that ended more than 180 days ago (`WLP_FACTORY_ATTACHMENT_DAYS`). Deleting an item removes its screenshots. Storage failures are retried.

On the item’s page the owner’s signed-in connection calls `itemAttachmentLinks(itemId)`. The returned inline PNG links expire after ten minutes. API clients with `items:read` can GET `/api/items/<id>/attachments/<aid>` for a one-minute redirect. GitHub gets a link to the item page. If a Content-Security-Policy is added, its `img-src` must allow the private bucket’s origin.
