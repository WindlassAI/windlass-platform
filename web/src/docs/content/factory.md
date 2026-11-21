## What a work item is

A work item is a task on one of your GitHub repositories that an agent carries through on its own. You write what you want done. An agent works on it in a sandbox, runs your checks, pushes a branch, waits for CI and hands it to you as a pull request. When it needs a decision from you, it waits under **Needs you**. Merging always stays yours.

Work items need a repository from your GitHub connection, and they always run with Windlass. The Factory is offered where the platform turns work items on. Then **Agents · Factory** appears in the bar.

## File a work item

### From the Factory page

1. Open **Factory** in the bar.
2. In the composer, switch from **Agent** to **Work item**.
3. Type the task in **What should be done?** The first line becomes the title. The rest is the body.
4. Choose the repository under **repo**, and the machine under **on** if you like.
5. Optionally, add **Acceptance criteria** under **criteria**, one per line. The agent is given them, and the verdict lists them for you to check. No machine checks them.
6. Press <kbd>Enter</kbd>, or choose **File**, to file it and start it.

To file it without starting it, choose **File as a draft**, or press <kbd>Alt</kbd>+<kbd>Enter</kbd>. Start a draft later from its page.

### From a repository's page

Choose **New work item…**. Fill in **Title**, **What to do** and, if you like, **Acceptance criteria**. Leave **Start now** ticked and choose **File and start**, or choose **File as a draft**.

### From a GitHub issue

Where the platform receives GitHub's events, you can file a work item from an issue:

- add the label `windlass` to the issue; or
- write a comment whose first word is the App's handle, `@` and its name, or `/windlass`. The rest of the comment is added to the task as a note.

For this to work, you must have connected that GitHub account in Windlass, and you must have write access to the repository. Lines like `- [ ] text` in the issue become acceptance criteria.

- If you wrote the issue yourself, the item starts at once.
- If someone else wrote it, the item is filed as a draft for you to start. Its page says the text was written by them, not by you, and the agent is told to take it as a description of what is wanted, not as instructions.

The App comments on the issue to say it took the item, and links to it. It also says when the pull request is opened and when the item ends.

On GitHub, removing the label cancels a draft. Closing the issue cancels an item that has not reached review. Editing the issue later does not change the item: it keeps the text it was filed with.

### From the API

Make a token under **Settings** › **API tokens** › **New token…**. Give it **File work items**, **Read work items** or both. Copy its value when it is shown: it is not shown again.

- `POST /api/items` files a work item. Send `Authorization: Bearer <token>` and an `Idempotency-Key` header.
- `GET /api/items/<id>` reads where an item is, its verdict and its cost.

The body names the repository, the title, the body and, optionally, the acceptance criteria, sandbox, model, place and whether to start it. A title can be 80 characters long and a body 20,000. An item can have 20 criteria of up to 2,000 characters each. A token may make 60 requests a minute.

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

## The Factory page

The Factory page lists your items by what you must do:

- **Needs you**: items that ask you something, the longest waiting first.
- **Ready for you**: items in review.
- **In progress**: working, queued or waiting.
- **Drafts**.
- **Ended**: done, failed or cancelled, folded away.

Filter it with **repo** and **from**: filed from the web, the API or a GitHub issue. The filters are kept in the address, as `?repository=` and `?from=`.

## Limits

Limits make items wait. They never refuse them. A waiting item says what it waits for. The platform sets these, and the **Work items** section of the **Usage** page shows them. By default:

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

When an item reaches its own budget of tokens, turns, working time or hosted sandbox time, it stops and asks you, for example "This item has used 6M of its 6M tokens."
