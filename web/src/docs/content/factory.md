## What a work item is

A work item is a task on one of your GitHub repositories that an agent carries through on its own. You write what you want done. An agent works on it in a sandbox, runs your checks, pushes a branch, waits for CI and hands it to you as a pull request. When it needs a decision from you, it waits under **Needs you**. Merging always stays yours.

Work items need a repository from your GitHub connection, and they always run with Windlass. The Factory is offered where the platform turns work items on. Then **Agents · Factory** appears in the bar.

A work item runs in one of two ways:

- **Single**: "One agent builds it and hands over one pull request." This is the default.
- **Orchestrate**: "For a new feature with several parts. A planner splits it into subtasks you approve." See [Orchestrate a feature](#orchestrate-a-feature).

## File a work item

### From the Factory page

1. Open **Factory** in the bar.
2. In the composer, switch from **Agent** to **Work item**.
3. Type the task in **What should be done?** The first line becomes the title. The rest is the body.
4. Choose the repository under **repo**, and the machine under **on** if you like.
5. Optionally, add **Acceptance criteria** under **criteria**, one per line. The agent is given them, and the verdict lists them for you to check. No machine checks them.
6. Where the platform offers orchestration, choose **Single** or **Orchestrate** on the **How it runs** pill beside the button.
7. Press <kbd>Enter</kbd>, or choose **File**, to file it and start it.

To file it without starting it, choose **File as a draft**, or press <kbd>Alt</kbd>+<kbd>Enter</kbd>. Start a draft later from its page.

### From a repository's page

Choose **New work item…**. Fill in **Title**, **What to do** and, if you like, **Acceptance criteria**. Choose **Single** or **Orchestrate** under **How it runs**, where it is offered. Leave **Start now** ticked and choose **File and start**, or choose **File as a draft**.

### From a GitHub issue

Where the platform receives GitHub's events, you can file a work item from an issue:

- add the label `windlass` to the issue; or
- write a comment whose first word is the App's handle, `@` and its name, or `/windlass`. The rest of the comment is added to the task as a note.

For this to work, you must have connected that GitHub account in Windlass, and you must have write access to the repository. Lines like `- [ ] text` in the issue become acceptance criteria.

To orchestrate it, add the label `windlass:orchestrate` instead, or start the comment after the App's handle with the word `orchestrate`. An issue labelled `bug` always runs as a single item, and the App's comment ends with "This issue has the bug label, so it runs as a single item."

- If you wrote the issue yourself, the item starts at once.
- If someone else wrote it, the item is filed as a draft for you to start. Its page says the text was written by them, not by you, and the agent is told to take it as a description of what is wanted, not as instructions.

The App comments on the issue to say it took the item, and links to it. It also says when the pull request is opened and when the item ends.

On GitHub, removing the label cancels a draft. Closing the issue cancels an item that has not reached review. Editing the issue later does not change the item: it keeps the text it was filed with.

### From the API

Make a token under **Settings** › **API tokens** › **New token…**. Give it **File work items**, **Read work items** or both. Copy its value when it is shown: it is not shown again.

- `POST /api/items` files a work item. Send `Authorization: Bearer <token>` and an `Idempotency-Key` header.
- `GET /api/items/<id>` reads where an item is, its verdict and its cost.

The body names the repository, the title, the body and, optionally, the acceptance criteria, sandbox, model, place, whether to start it and `"mode"`: `"single"`, the default, or `"orchestrate"`. A token cannot approve a plan: you approve it on the item's page. A title can be 80 characters long and a body 20,000. An item can have 20 criteria of up to 2,000 characters each. A token may make 60 requests a minute. The same `Idempotency-Key` with the same body answers with the item the first attempt made; with another body it is refused with `409` and `idempotency_key_reused`. A missing, invalid or out-of-scope token gets `401` and `invalid_token`. A rate limit gets `429` with `Retry-After`. Every error has a JSON `code` and `message`. Where the platform does not offer work items, both routes answer `404`.

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

Each such stop offers **Raise the limit and go on**, **Retry from scratch**, **Give up** and, once there is a pull request, **Hand it over as it is**. Nothing is stopped silently.

### What you can do with an item

- **Start** a draft.
- **Retry** an item that failed.
- **Send back…** an item in review, with a note. Its agent works on the same branch, the pull request is updated and the work gets a new verdict. A review you leave on the pull request at GitHub is not read, so say what the agent should know in the note.
- **Cancel…** an item.

## Orchestrate a feature

Use **Orchestrate** for a new feature with several parts that one agent would struggle to hold at once. Use **Single** for a fix, a small change or anything one pull request from one agent can carry.

An orchestrated item, a feature, works like this:

1. **Planning**: a planner agent reads the task, the repository and your machines, and files a plan. It cannot write, edit or run commands.
2. You review the plan on the item's page, set its budgets and approve it.
3. **Subtasks**: each subtask runs as a work item of its own, under the feature, one at a time, in the order the plan's dependencies allow.
4. **Feature summary**: once every subtask is done, an agent writes the pull request's summary.
5. CI runs on the whole feature, a second review reads it, and the feature is handed to you as one pull request.

### What you need first

Approving a plan needs two things on the repository:

- saved [checks](/docs/settings#checks);
- CI that reports on pushes to the feature's branches, `windlass/feature-<id>` and its subtasks' branches. An enabled GitHub Actions workflow with `on: push` will do, as long as its branch filters do not leave those branches out. CI of another kind counts once it has passed on an earlier `windlass/` branch pushed without a pull request. A workflow that runs only on pull requests is not enough.

Without them, approval is refused. File it as single instead. The **How it runs** pill warns you before you file when the repository has no saved checks: "No checks are saved for this repository, so a plan cannot be approved. File it as single, or save checks first."

### The plan

The plan says what the feature is for, what it must do, what is left out of it and when it is done. Then it lists 2 to 6 subtasks. Each subtask has a title, a brief, the paths it owns, the subtasks it waits for, how it is checked and a budget. Subtasks that do not wait for each other may not own the same paths.

The planner may ask you questions with the plan. It may also say that one item is enough. The page then says "The planner suggests one item instead: …", and offers **Run as single item** or **Orchestrate anyway**.

The planner reads what you wrote about your machines under [Say when to use it](/docs/machines#say-when-to-use-it).

### Review and approve it

When the plan is ready, the item waits under **Needs you**: "Its plan waits for your approval." Its page shows **It asks you**, "Review the plan: N subtasks, X tokens of the Y the feature may spend", and the plan below it.

- Answer the plan's questions, if it has any.
- Change a subtask's budget: tokens, turns, working minutes and, on this platform, hosted minutes. **Together** shows the total against what the subtasks may share.
- Choose **Save as version N** to keep your changes, or **Discard changes**.
- Choose **Approve version N** to start the subtasks.
- Choose **Ask for a new plan** to have the planner try again, or **Give up**.

If approval is refused because the repository lacks checks or push CI, **Run as a single item** turns the feature into one ordinary item and starts it. The tokens spent on planning stay counted.

### Budgets

A feature may spend three times what one item may: by default 18,000,000 tokens, 42 turns, 12 hours of working time and 6 hours of hosted sandbox time. Part of that, 1,000,000 tokens and 4 turns by default, is kept for the summary and the review. A subtask gets at most what one item may, and at least 2 turns and a tenth of one item's tokens and times.

When a feature reaches its budget, it stops and asks you. **Raise the limit and go on** may raise each figure by at most one item's allowance at a time.

### Subtasks

Each subtask is a work item with its own page, which says **subtask of** the feature. It starts from the feature's branch, runs in the feature's place, sandbox and model, and has the subtask's budget. It is given its brief, its paths and the reports of the subtasks it waits for.

A subtask opens no pull request of its own. It pushes its branch, and joins the feature only when its checks pass and CI passes on its commit. The platform then moves the feature's branch forward to it. If the feature's branch moved meanwhile, the subtask rebases onto it and is checked again.

Subtasks are not listed on the Factory page unless they ask you something.

If a subtask fails or is cancelled, the planner revises the plan for the work left. Done subtasks stay as they are. You review and approve the revised plan again. A feature can be revised this way twice.

### The pull request

When you approve the plan, the platform opens a draft pull request from `windlass/feature-<id>` into the base branch. Each subtask's work lands on that branch. When the feature is handed over, the pull request is marked ready for review. As with every item, merging stays yours.

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
- **Ended**: done, failed or cancelled, folded away.

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
