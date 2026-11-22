## What a work item is

A work item is a task on one of your GitHub repositories that an agent carries through on its own. You write what you want done. An agent works on it in a sandbox, runs your checks, pushes a branch, waits for CI and hands it to you as a pull request. When it needs a decision from you, it waits under **Needs you**. Merging always stays yours.

Work items need a repository from your GitHub connection, and they always run with Windlass. The Factory is offered where the platform turns work items on. Then **Agents · Factory** appears in the bar.

A work item runs in one of two ways:

- **Plan first** is the default. A read-only planner files a feature plan. You approve the scope on the item page, then one implementer follows it or the approved subtasks run. See [Orchestrate a feature](#orchestrate-a-feature).
- **Quick** skips the plan and sends the request directly to one implementer. Choose it for an individual item, including a bug filed from the web.

## File a work item

### From the Factory page

1. Open **Factory** in the bar.
2. In the composer, switch from **Agent** to **Work item**.
3. Type the task in **What should be done?** The first line becomes the title. The rest is the body.
4. Choose the repository under **repo**, and the machine under **on** if you like.
5. Optionally, add **Acceptance criteria** under **criteria**, one per line. The agent is given them, and the verdict lists them for you to check. No machine checks them.
6. Where the platform offers orchestration, leave **Plan first** selected or choose **Quick** under **How it runs**.
7. Press <kbd>Enter</kbd>, or choose **File**, to file it and start it.

To file it without starting it, choose **File as a draft**, or press <kbd>Alt</kbd>+<kbd>Enter</kbd>. Start a draft later from its page.

### From a repository's page

Choose **New work item…**. Fill in **Title**, **What to do** and, if you like, **Acceptance criteria**. Choose **Plan first** or **Quick** under **How it runs**, where it is offered. Leave **Start now** ticked and choose **File and start**, or choose **File as a draft**.

### From a GitHub issue

Where the platform receives GitHub's events, you can file a work item from an issue:

- add the label `windlass` to the issue; or
- write a comment whose first word is the App's handle, `@` and its name, or `/windlass`. The rest of the comment is added to the task as a note.

For this to work, you must have connected that GitHub account in Windlass, and you must have write access to the repository. Lines like `- [ ] text` in the issue become acceptance criteria.

A plain `windlass` label or App mention selects **Plan first**. The label `windlass:orchestrate` and a note starting with `orchestrate` also select it. To skip planning, apply `windlass:quick` or start the note with `quick`, for example `/windlass quick fix the typo`. An issue labelled `bug` always runs **Quick**. An explicit Quick choice also wins if both modes are requested. The App’s reply names the filing mode.

With `WLP_FACTORY_ORCHESTRATE=0`, ordinary requests run **Quick** and the web forms hide the mode selector. An explicit request for orchestration on that deployment is refused.

- If you wrote the issue yourself, the item starts at once.
- If someone else wrote it, the item is filed as a draft for you to start. Its page says the text was written by them, not by you, and the agent is told to take it as a description of what is wanted, not as instructions.

The App comments on the issue to say it took the item, and links to it. It also says when the pull request is opened and when the item ends.

On GitHub, removing the label cancels a draft. Closing the issue cancels an item that has not reached review. Editing the issue later does not change the item: it keeps the text it was filed with.

### From the API

Make a token under **Settings** › **API tokens** › **New token…**. Give it **File work items**, **Read work items** or both. Copy its value when it is shown: it is not shown again.

- `POST /api/items` files a work item. Send `Authorization: Bearer <token>` and an `Idempotency-Key` header.
- `GET /api/items/<id>` reads where an item is, its verdict and its cost.

**API default change.** Clients that previously omitted `mode` to launch one implementer must now send `"mode": "single"`. Omitting `mode` selects Plan first and waits for owner approval when orchestration is enabled.

The body names the repository, the title, the body and, optionally, the acceptance criteria, sandbox, model, place, whether to start it and `"mode"`: `"orchestrate"` for Plan first (the default when enabled), or `"single"` for Quick. A token cannot approve a plan: you approve it on the item's page. A title can be 80 characters long and a body 20,000. An item can have 20 criteria of up to 2,000 characters each. A token may make 60 requests a minute. The same `Idempotency-Key` with the same body answers with the item the first attempt made; with another body it is refused with `409` and `idempotency_key_reused`. A missing, invalid or out-of-scope token gets `401` and `invalid_token`. A rate limit gets `429` with `Retry-After`. Every error has a JSON `code` and `message`. Where the platform does not offer work items, both routes answer `404`.

## The pipeline

Each item goes through these steps, in order. Its page shows where it is.

1. **Implementing**: its agent works on the task.
2. **Checks**: the platform reads what the checks of the last turn found. If one fails, the agent is sent back to fix it.
3. **Pushing**: the platform pushes the work and opens or updates the pull request.
4. **Waiting for CI**.
5. **Fixing CI**: its agent works on what CI reported.
6. **Merging the base**: its agent merges the base branch into its own, if they conflict.
7. **Second review**: a second agent reviews the pushed commit in its own sandbox, where the platform offers it.
8. **Handed over**: the item is **In review**, and waits under **Ready for you**.
9. **Waiting for the merge**: when you merge the pull request on GitHub, the item is **Done**. If you close it, the item is **Cancelled**.

The platform never merges the pull request.

### Your checks

Set checks in the repository's settings, under **Checks**. Windlass runs them before it calls a turn done, in the agent's own sandbox, and sends the agent back with what fails, three times at most. Without checks, an item's verdict rests on CI alone.

### CI

If no CI starts within 10 minutes of a push, the item is handed over without it. If CI is still running after 90 minutes, the item asks you what to do.

### The second review

A second agent, with no part in making the change, checks out the pushed commit in its own sandbox and reads it against the task. It approves, asks for changes, or says it needs you. Its findings are marked **Blocking**, **Should fix** or **Note**. Its recommendation does nothing by itself: the item is handed to you either way.

The second review is off unless the platform turns it on. The Factory page says when there is none.

### Screenshots

Turn on **Take screenshots for work items** in the repository's settings, under **Screenshots**, to let builders and reviewers attach pictures of the app to their reports. It is off by default. A screenshot is a PNG of up to 2 MiB. An item can have 40. They are kept for 180 days after the item ends.

## The verdict

When an item is handed over, its page gives a verdict, such as **Ready for review**, **Needs a look** or **Failing**. The verdict rests on CI on the pushed commit, your checks where you set them, and what was seen in the changes. It never rests on the agent's words. A verdict merges nothing.

## When an item needs you

An item waits under **Needs you** when it asks you something, under **It asks you** on its page. For example, when its turn could not start, when GitHub refused the push, when CI has not finished, or when it reached a limit. Choose one of the answers it offers, such as **Try again**, **Keep waiting**, **Raise the limit and go on**, **Hand it over as it is** or **Give up**. An item's question waits until you answer.

An item also stops and asks you when it keeps failing:

- the checks still fail after 2 more turns of fixing;
- CI failed again after 2 rounds of fixes;
- the pull request still conflicts with its base after a round of merging it;
- the same failure came back after a fix;
- it reached its own budget.

The choices depend on the item. A subtask can only integrate after its checks and CI pass. Only the item that owns the pull request can hand it over. Nothing is stopped silently.

### What you can do with an item

- **Start** a draft.
- **Retry** a failed top-level item if it has not started dispatching subtasks.
- **Send back…** a single-implementer item in review, with a note. Its agent works on the same branch, the pull request is updated and the work gets a new verdict. A review you leave on the pull request at GitHub is not read, so say what the agent should know in the note.
- **Cancel…** an item.

## Orchestrate a feature

Plan first starts with a plan whether the feature needs one implementer or several.

1. **Planning**. A read-only planner examines the task, repository and available machines, then files a FeaturePlan with requirements, done-when checks and work that is out of scope.
2. Review the plan on the item page. If the planner recommends one implementer, choose **Approve for one implementer** to approve that scope. The implementer receives the task and the plan. Planning spend stays visible. The implementer gets one Quick allowance within the feature cap.
3. If the planner proposes a split, review the subtask budgets and approve the plan. The Factory runs the subtasks in dependency order.
4. **Feature summary**: once every subtask is done, an agent writes the pull request's summary.
5. CI runs on the whole feature, a second review reads it, and the feature is handed to you as one pull request.

### What you need first

Approving a split into subtasks needs two things on the repository:

- saved [checks](/docs/settings#checks);
- CI that reports on pushes to the feature's branches, `windlass/feature-<id>` and its subtasks' branches. An enabled GitHub Actions workflow with `on: push` will do, as long as its branch filters do not leave those branches out. CI of another kind counts once it has passed on an earlier `windlass/` branch pushed without a pull request. A workflow that runs only on pull requests is not enough.

If these checks are missing, you can still run the plan with one implementer. The composer flags repositories with no saved checks.

### The plan

The plan says what the feature is for, what it must do, what is left out of it and when it is done. A split plan also lists 2 to 6 subtasks. Each subtask has a title, a brief, the paths it owns, the subtasks it waits for, how it is checked and a budget. Subtasks that do not wait for each other may not own the same paths.

On the item's page the plan's goal comes first, then **Requirements**, **Done when** and **Not in it** as short lists. A long list shows its first three lines and **Show N more**. A plan that was set aside, for example after its revisions were used, is marked **superseded** and folded into one line. Choose it to read the plan.

Current runners support one sandbox slot per subtask. Approval requires a ready placement.

The planner may ask you questions with the plan. It may also say that one item is enough. The item shows the planner’s reason and offers **Approve for one implementer** or **Ask for subtasks**.

The planner reads what you wrote about your machines under [Say when to use it](/docs/machines#say-when-to-use-it).

### Review and approve it

When the plan is ready, the item waits under **Needs you**: "Its plan waits for your approval." Its page shows **It asks you**, "Review the plan: N subtasks, X tokens of the Y the feature may spend", and the plan below it.

- Answer the plan's questions, if it has any.
- Change a subtask's budget: tokens, turns, working minutes and, on this platform, hosted minutes. You can also change where it runs: see [Placement](#placement). **Allotted to subtasks** shows the proposed total against what the subtasks may share. Once children exist, it also shows their actual spend.
- Choose **Save as version N** to keep your changes, or **Discard changes**.
- Choose **Approve version N** to start the subtasks.
- Choose **Ask for a new plan** to have the planner try again, or **Give up**.

If approval is refused because the repository lacks checks or push CI, **Run as a single item** turns the feature into one ordinary item and starts it. The tokens spent on planning stay counted.

### Placement

Each subtask says where it **runs on**: the place the planner prefers and why, and, when it **needs** something of a place (CPUs, memory, screenshots, a harness, egress or tags), what. A subtask with no place runs where the feature does. The plan's **overflow** line says whether a subtask whose preferred machine is busy may run on one of the alternatives it lists.

The approval card lists, under **Where each subtask runs**, each subtask's place, the planner's reason, its alternatives, whether overflow is allowed and, for every place, whether the repository's secrets are sent there: **secrets sent** or **no secrets**. This platform always gets them; a machine gets them only while its **Send saved secrets** switch is on. The planner may have read an issue anyone could file, so check this before you approve.

While the plan is open you can change a subtask's place from your machines or this platform, its alternatives, and overflow, then save them with the budgets as the next version. A place the platform would refuse, for example a machine whose owner chose **Never** under [Let features use it](/docs/machines#let-features-use-it), or one without screenshots for a subtask that needs them, shows **can't place** and the reason. A refused approval shows the same reason under the subtask. A busy or offline machine is not refused: the subtask waits for it.

Once a subtask has its item, its row says where it **ran on** and why, for example "nas · 2 slots" and "Approved overflow from ‘studio’". When the feature waits for a machine, the next subtask's row says which machine and for what, for example "Waiting for 2 free slots on ‘studio’. 0 free now."

### Budgets

A feature may spend three times what one item may: by default 18,000,000 tokens, 42 turns, 12 hours of working time and 6 hours of hosted sandbox time. Before each planning turn, the factory checks a planning allowance of 25% of a Quick item across all planning turns. Part of the feature budget, 1,000,000 tokens and 4 turns by default, is kept for the summary and the review. A subtask gets at most what one item may, and at least 2 turns and a tenth of one item's tokens and times.

When a feature reaches its budget, it stops and asks you. **Raise the limit and go on** may raise each figure by at most one item's allowance at a time.

### Subtasks

Each subtask is a work item with its own page, which says **subtask of** the feature. It starts from the feature's branch, runs at its approved placement with the feature’s model, and has the subtask's budget. It is given its brief, its paths and the reports of the subtasks it waits for.

A subtask opens no pull request of its own. It pushes its branch, and joins the feature only when its checks pass and CI passes on its commit. The platform then moves the feature's branch forward to it. If the feature's branch moved meanwhile, the subtask rebases onto it and is checked again.

Subtasks are not listed on the Factory page unless they ask you something.

If a subtask fails or is cancelled, the planner revises the plan for the work left. Done subtasks stay as they are. You review and approve the revised plan again. A feature can be revised this way twice.

### The pull request

When you approve a split plan, the platform opens a draft pull request from `windlass/feature-<id>` into the base branch. Each subtask's work lands on that branch. When the feature is handed over, the pull request is marked ready for review. As with every item, merging stays yours.

A feature gets no turns of its own to fix CI or merge its base. If CI fails on the whole feature, or the pull request conflicts with its base, the feature asks you, with **Check the feature PR again**, **Hand it over as it is** and **Give up**.

### When orchestration stops

These stop the feature and ask you:

- a subtask has no passing checks or no CI on its push: "Orchestration stopped because a subtask lacks passing local checks or push CI. Hand over the feature PR or give up.";
- two subtasks stopped with the same failure;
- both revisions of the plan have been used;
- the budget left cannot cover the next subtask: "The remaining feature budget cannot cover …";
- no CI passed on the whole feature within 10 minutes: "No passing CI reported on the complete feature. Wait for a check or hand over the PR."

Cancelling a feature cancels its subtasks too.

## The Factory page

The Factory page lists your items by what you must do:

- **Needs you**: items that ask you something, the longest waiting first.
- **Ready for you**: items in review.
- **In progress**: working, queued or waiting.
- **Drafts**.
- **Ended**: done, failed or cancelled, folded away. Unfolded, they show 25 at a time, the newest first. Choose **Show 25 more** for the next ones.

Filter it with **repo** and **from**: filed from the web, the API or a GitHub issue. The filters are kept in the address, as `?repository=` and `?from=`.

## Limits

Limits make items wait. They never refuse them. (Approving a feature's plan can be refused, but that is a requirement of the repository, not a limit. See [What you need first](#what-you-need-first).) A waiting item says what it waits for. The platform sets these, and the **Work items** section of the **Usage** page shows them. By default:

| Limit | Default |
| --- | --- |
| Factory turns at once | 5, out of 6 agents working at once |
| Hosted sandboxes at once | 3 |
| Items in review before new ones wait | 6 |
| Tokens per item | 6,000,000 |
| Turns per item | 14 |
| Working time per item | 4 hours |
| Hosted sandbox time per item | 2 hours |
| Items filed from GitHub per day | 20 |
| Drafts from GitHub waiting | 20 |

When an item reaches its own budget of tokens, turns, working time or hosted sandbox time, it stops and asks you, for example "This item has used 6M of its 6M tokens." A feature's budget is three times an item's. See [Budgets](#budgets).
