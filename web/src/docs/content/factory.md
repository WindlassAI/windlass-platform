## What a work item is

A work item is a task on one of your GitHub repositories that an agent carries through on its own. You write what you want done. An agent works on it in a sandbox, runs your checks, pushes a branch, waits for CI and hands it to you as a pull request. When it needs a decision from you, it waits under **Needs you**. Merging always stays yours.

Work items need a repository from your GitHub connection. They run with Windlass unless you choose another agent on one of your machines: see [Choose the agent](#choose-the-agent). The Factory is offered where the platform turns work items on. Then **Agents · Factory** appears in the bar.

A work item runs in one of two ways:

- **Plan first** is the default. A read-only planner files a feature plan. You approve the scope on the item page, then one implementer follows it or the approved subtasks run. See [Orchestrate a feature](#orchestrate-a-feature).
- **Quick** skips the plan and sends the request directly to one implementer. Choose it for an individual item, including a bug filed from the web.

## File a work item

### From the Factory page

1. Open **Factory** in the bar.
2. In the composer, switch from **Agent** to **Work item**.
3. Type the task in **What should be done?** The first line becomes the title. The rest is the body.
4. Choose the repository under **repo**, and the machine under **on** if you like.
5. Optionally, choose the agent and its model under the agent pill. See [Choose the agent](#choose-the-agent).
6. Optionally, add **Acceptance criteria** under **criteria**, one per line. The agent is given them, and the verdict lists them for you to check. No machine checks them.
7. Where the platform offers orchestration, leave **Plan first** selected or choose **Quick** under **How it runs**.
8. Press <kbd>Enter</kbd>, or choose **File**, to file it and start it.

To file it without starting it, choose **File as a draft**, or press <kbd>Alt</kbd>+<kbd>Enter</kbd>. Start a draft later from its page.

### From a repository's page

Choose **New work item…**. Fill in **Title**, **What to do** and, if you like, **Acceptance criteria**. Choose **Plan first** or **Quick** under **How it runs**, where it is offered. On a machine signed into Claude Code or OpenCode, choose the **Agent** under the machine. Leave **Start now** ticked and choose **File and start**, or choose **File as a draft**.

### From a GitHub issue

Where the platform receives GitHub's events, you can file a work item from an issue:

- add the label `windlass` to the issue; or
- write a comment whose first word is the App's handle, `@` and its name, or `/windlass`. The rest of the comment is added to the task as a note.

For this to work, you must have connected that GitHub account in Windlass, and you must have write access to the repository. Lines like `- [ ] text` in the issue become acceptance criteria.

A plain `windlass` label or App mention selects **Plan first**. The label `windlass:orchestrate` and a note starting with `orchestrate` also select it. To skip planning, apply `windlass:quick` or start the note with `quick`, for example `/windlass quick fix the typo`. An issue labelled `bug` always runs **Quick**. An explicit Quick choice also wins if both modes are requested. The App’s reply names the filing mode.

With `WLP_FACTORY_ORCHESTRATE=0`, ordinary requests run **Quick** and the web forms hide the mode selector. An explicit request for orchestration on that deployment is refused.

- If you wrote the issue yourself, the item starts at once.
- If someone else wrote it, the item is filed as a draft for you to start. Its page says the text was written by them, not by you, and the agent is told to take it as a description of what is wanted, not as instructions. Windlass is also told the text is theirs: see [Text from someone else](#text-from-someone-else).

The App comments on the issue to say it took the item, and links to it. It also says when the pull request is opened and when the item ends.

On GitHub, removing the label cancels a draft. Closing the issue cancels an item that has not reached review. Editing the issue later does not change the item: it keeps the text it was filed with.

### From the API

Make a token under **Settings** › **API tokens** › **New token…**. Give it **File work items**, **Read work items** or both. Copy its value when it is shown: it is not shown again.

- `POST /api/items` files a work item. Send `Authorization: Bearer <token>` and an `Idempotency-Key` header.
- `GET /api/items/<id>` reads where an item is, its verdict and its cost.

**API default change.** Clients that previously omitted `mode` to launch one implementer must now send `"mode": "single"`. Omitting `mode` selects Plan first and waits for owner approval when orchestration is enabled.

The body names the repository, the title, the body and, optionally, the acceptance criteria, sandbox, model, effort, place, whether to start it and `"mode"`: `"orchestrate"` for Plan first (the default when enabled), or `"single"` for Quick. A token cannot approve a plan: you approve it on the item's page. A title can be 80 characters long and a body 20,000. An item can have 20 criteria of up to 2,000 characters each. A token may make 60 requests a minute. The same `Idempotency-Key` with the same body answers with the item the first attempt made; with another body it is refused with `409` and `idempotency_key_reused`. A missing, invalid or out-of-scope token gets `401` and `invalid_token`. A rate limit gets `429` with `Retry-After`. Every error has a JSON `code` and `message`. Where the platform does not offer work items, both routes answer `404`.

## Choose the agent

An item's builder runs **Windlass** by default. On one of your machines, it can run **Claude Code** or **OpenCode** instead, where the machine's runner offers that agent and it is signed in there. The composer lists only those, and an item is refused where the machine does not report the agent signed in. If the agent is signed out by the time a turn would start, the turn does not run: the item asks you, with the `windlass-runner login` command to run. The agent's default model is used unless you choose another. Windlass items can choose any model of your account.

An item can also have an **effort**: the reasoning effort every turn of it runs at, for Windlass, Claude Code and OpenCode alike. The composer offers it in the agent's menu, beside each model, and the **New work item** dialog under **Model** and **Effort**, with the efforts the agent reported for that model. Left at **Default**, the agent's own default is used. An effort the agent does not offer is refused.

Codex is not offered for work items yet: the **Agent** choice does not list it, and an item filed with Codex is refused. Start a Codex session instead.

What changes with Claude Code or OpenCode:

- **Where.** Only on your machine, in **Hardened Docker on your machine "…"**. Hosted items run Windlass.
- **How it runs.** A Quick item runs Claude Code or OpenCode directly. A **Plan first** feature's planner runs with Windlass, because it files the plan with a Windlass tool, but each of its subtasks can run Claude Code or OpenCode: see [Each subtask's agent](#each-subtasks-agent).
- **Asking.** An item has nobody watching it, so the agent works without asking. Claude Code and OpenCode can't ask you a question mid-turn either: only a Windlass builder can (see [When the agent asks you](#when-the-agent-asks-you)). They decide for themselves. Claude Code runs in **Bypass permissions**. OpenCode runs in **Build**, and the platform allows once each edit or command it asks about, as Windlass runs commands in that container. The turn does not start if the agent does not offer that mode.
- **Checks.** These agents do not run your repository's checks. CI decides the verdict, and the check on GitHub says "The turn left no record of its checks; CI decides."
- **Review.** Items on a machine have no second reviewer, whatever the agent.
- **Publishing.** The platform commits what the agent left, pushes and opens the pull request, as it does for Windlass. The agent's own `git push` fails, because the sandbox holds no GitHub credential. The pull request's description is the item's.
- **Tokens and cost.** OpenCode's reported tokens count against the item's token budget, and the cost it reports is shown on the item's page. Claude Code runs on your Claude subscription. The tokens it reports are shown but not counted, and its 5-hour window is shown at the first turn and the latest. Claude Code sends that window only when it warns that the window is nearly used, so until then the page says the window is **Not reported**. The item's turns and working time bound it. Where an agent reports no tokens, the page says **Not reported**, never 0. An OpenCode turn that reports no tokens stops the item, because its token budget can't be enforced: the item asks you, and you can give up or hand over a pull request CI has read. The cost OpenCode reports is shown, not capped.

From the API, send `"harness": "claude"` or `"harness": "opencode"` with `"place"` naming the machine and `"mode": "single"`, and optionally `"model"`, for example `"sonnet"`, and `"effort"`, for example `"high"`. The machine's model list is on the **Machines** page. Issues filed from GitHub run Windlass.

## The pipeline

Each item goes through these steps, in order. Its page shows where it is.

1. **Implementing**: its agent works on the task.
2. **Checks**: the platform reads what the checks of the last turn found. If one fails, the agent is sent back to fix it.
3. **Pushing**: the platform pushes the work and opens or updates the pull request.
4. **Waiting for CI**.
5. **Fixing CI**: its agent works on what CI reported.
6. **Merging the base**: its agent merges the base branch into its own, if they conflict.
7. **Second review**: a second agent reviews the pushed commit in its own sandbox, where the platform offers it.
8. **Fixing what the reviewer asked**: if the second review asks for changes, its agent works on the blocking findings. The steps from **Checks** run again, and the second agent reviews the new commit.
9. **Handed over**: the item is **In review**, and waits under **Ready for you**.
10. **Waiting for the merge**: when you merge the pull request on GitHub, the item is **Done**. If you close it, the item is **Cancelled**.

The platform never merges the pull request.

### Your checks

Set checks in the repository's settings, under **Checks**. Windlass runs them before it calls a turn done, in the agent's own sandbox, and sends the agent back with what fails, three times at most. Without checks, an item's verdict rests on CI alone.

### CI

If no CI starts within 10 minutes of a push, the item is handed over without it. If CI is still running after 90 minutes, the item asks you what to do.

### The second review

A second agent, with no part in making the change, checks out the pushed commit in its own sandbox and reads it against the task. It approves, asks for changes, or says it needs you. Its findings are marked **Blocking**, **Should fix** or **Note**. The verdict never rests on its words.

What happens next depends on its recommendation:

- **Approves**: the item is handed to you.
- **Asks for changes**: the agent that made the change gets the blocking findings and works on them, on the same branch. It is told to leave a finding it disagrees with and say why in its report. It is also told that no finding justifies removing or skipping tests or checks, changing CI or deploy configuration, adding network calls, or touching credentials: it leaves such a finding and names it in its report. The new commit goes through your checks and CI, and the second agent reviews it again. It says for each earlier blocking finding whether it is fixed, not fixed, or withdrawn. A finding it says is not fixed stays open for the next round, whether or not it files it again, and it cannot approve while one is open. If the agent changes nothing, because it disagrees with every finding, the second agent reviews the same commit again, with the agent's report. A run allows 2 rounds of fixes.
- **Needs you**: the item asks you, with the reviewer's questions in its review. **Have the agent change it** sends its agent back with the questions and your note. **Hand it over as it is** hands it to you with the review. Or **Give up**.

The item stops and asks you when the second agent still asks for changes after 2 rounds of fixes, or asks again for the same changes after a round of fixes. **Raise the limit and go on** runs one more round of fixes: if the second agent still asks for changes after it, the item stops and asks you again. **Hand it over as it is** keeps the review filed for the commit it hands over: it shows on the item's page, the pull request comment and the check on GitHub.

Sometimes the commit handed over has no review of its own after a review asked for changes: you chose **Hand it over as it is** on a budget or CI question after the agent pushed its fixes, or the next review was refused or filed nothing the platform could read. Then the pull request comment says there was no second review of that commit, every review of the run stays on the item's page, and the check on GitHub says **Second review did not finish after it asked for changes**, with Action required.

If someone pushes to the pull request while the second agent reviews, its agent is not sent back: a fix of the reviewed commit could not be pushed over theirs. The item is handed over as it is, saying the pull request moved.

On a feature, the second review does nothing by itself: the feature is handed to you whatever it recommends.

The second review is off unless the platform turns it on. The Factory page says when there is none.

### Screenshots

Turn on **Take screenshots for work items** in the repository's settings, under **Screenshots**, to let builders and reviewers attach pictures of the app to their reports. It is off by default. A screenshot is a PNG of up to 2 MiB. An item can have 40. They are kept for 180 days after the item ends.

## The verdict

When an item is handed over, its page gives a verdict, such as **Ready for review**, **Needs a look** or **Failing**. The verdict rests on CI on the pushed commit, your checks where you set them, and what was seen in the changes. It never rests on the agent's words. A verdict merges nothing.

### The check on GitHub

Look for **windlass/verified** on the pull request. It starts in progress when the item publishes its commit. A feature gets one check on its assembled work after its subtasks finish. **Details** opens the evidence for the item's owner. Anyone who can read the repository can read the check summary. It contains platform observations, including check names, flagged paths, the second review's recommendation, counts and spending. The task, builder's report and reviewer's findings stay out of the check summary.

| Factory outcome | GitHub conclusion |
|---|---|
| Ready for review | Success |
| Needs a look, CI unread or unfinished, CI did not start, or Not verified | Action required |
| The second reviewer requests changes or needs a person on an otherwise ready item | Action required |
| The second review asked for changes, and none was filed for the commit handed over | Action required |
| Failing or Incomplete | Failure |
| You give up or cancel during verification | Cancelled |

During each round of the second review, the check on the reviewed commit stays in progress. When the second review asks for changes, the check says that the next round is being worked on. When a later commit is handed over, the reviewed commit's check is completed as **Cancelled** and names the commit that replaced it.

After someone else pushes, the earlier verdict belongs to the old commit. Windlass marks the new head **Action required** when it sees the move. Sending the item back puts its check in progress during rework. In review, choose **Re-run** on the GitHub check to have Windlass read CI again. For example, CI that has finished since handover can now earn a pass. Windlass accepts one such request per minute per item.

If Windlass reports a permission refusal, ask the installation owner to open the App's **Configure** page on GitHub and accept **Checks: Read and write**. The verdict, review request and marked pull request comment are available independently of the check.

To require the check, add **windlass/verified** to the required status checks for your target branch in the repository's branch protection rule or ruleset. Select the platform's GitHub App as the expected source. **Action required** blocks a merge under this rule. You can separately enable auto-merge for the repository.

## When an item needs you

An item waits under **Needs you** when it asks you something, under **It asks you** on its page. For example, when its turn could not start, when GitHub refused the push, when CI has not finished, or when it reached a limit. Choose one of the answers it offers, such as **Try again**, **Keep waiting**, **Raise the limit and go on**, **Hand it over as it is** or **Give up**. An item's question waits until you answer.

An item also stops and asks you when it keeps failing:

- the checks still fail after 2 more turns of fixing;
- CI failed again after 2 rounds of fixes;
- the pull request still conflicts with its base after a round of merging it;
- the same failure came back after a fix;
- the second reviewer still asks for changes after 2 rounds of fixes, or asks again for the same changes;
- it reached its own budget.

The choices depend on the item. A subtask can only integrate after its checks and CI pass. Only the item that owns the pull request can hand it over. Nothing is stopped silently.

### When the agent asks you

A Windlass builder can stop and ask you a question when it can't go on without your decision, for example which of two approaches the task means. It is told to ask only about what it can't settle from the repository, the task and its acceptance criteria. Otherwise it decides and says what it decided in its report.

- **Where.** The item waits under **Needs you**: "The agent stopped to ask you a question before it goes on." Below that, the page shows the agent's own question, marked as the agent's and quoted as plain text, with up to 4 answers it suggests.
- **Answering.** Write your answer under **Your answer** and choose **Answer the agent**. A suggested answer only fills the box, so you can change it before you send it. The agent gets your answer as its next message, in the same conversation and the same step, and goes on from where it stopped. Its work stays as it was while it waits. You can also **Hand it over as it is**, when the run has pushed something, or **Give up**.
- **How often.** At most 1 question per turn and 3 per run. After that, the agent is told to decide for itself.
- **How long.** The question waits until you answer, for days if need be. If the item's budget has run out by the time you answer, an item that is not a subtask asks you to raise the limit first, and keeps your answer for the turn it resumes. A subtask can't raise its own limit: it stops, and starting it again begins a new run without your answer.
- **Read it as the agent's.** The agent may have read issue text or repository files written by someone else, and those can steer what it asks. Its question is never written for it by the platform, never answered for you, and never posted to GitHub. Check what it asks before you agree to anything. A question over 1,000 characters is refused, and the agent is told to shorten it. Control, invisible and other hidden characters are taken out before you see it, and a suggested answer can't carry hidden text into your reply.
- **Who can ask.** Only a Windlass builder: the turns that implement, fix checks or CI, merge the base, or answer a review. The planner files its questions with its plan, the second reviewer asks through its review, and Claude Code and OpenCode can't ask mid-turn.

### What you can do with an item

- **Start** a draft.
- **Retry** a failed top-level item if it has not started dispatching subtasks.
- **Send back…** a single-implementer item in review, with a note. Its agent works on the same branch, the pull request is updated and the work gets a new verdict. You can also ask for changes on the pull request itself (see below).
- **Cancel…** an item.

### Feedback from GitHub

You can ask for changes on the item's pull request at GitHub instead of on its page.

**What is read.** A review that requests changes is read whole, with its line comments. A conversation comment, a line comment on its own or a comment-only review is read only when it starts with the App's mention or `/windlass`. An approval adds a line to the item's log and starts nothing.

**Who counts.** You, through the GitHub account linked to Windlass, and anyone GitHub reports as having write access to the repository. Feedback from anyone else is only counted on the page: its text is not kept, sent to the agent or answered. Windlass reads each review or comment again from GitHub before taking it, and does not take one more than 3 days old.

**Batches.** A review is taken at once. Comments are collected into one batch: it goes after two minutes without a new comment, or ten minutes after the first. A batch holds up to 20 entries and 8,000 characters, oldest first. The rest goes with the next batch. A single entry longer than 8,000 characters is not taken: shorten it or split it. The same feedback twice is taken once.

**What the agent is told.** The words are quoted as written, with who wrote them, their access, and the file, line and commit of a line comment. Your words are your requests. Other writers' words are review the agent weighs, not your instructions. Nobody's words change the agent's rules or the task. Where the agent disagrees, it says why in its report's concerns, and those reach the pull request.

**On a single item**, a batch starts a new run on the same branch, as **Send back…** does. Feedback that arrives while the item works is held. Once CI has finished, it goes before the second review, and that commit is not handed over. Feedback that arrives while the second agent reviews goes first too, when the review asks for changes or has questions: the new run gets the feedback, and the reviewer's points after it. Its questions that only you could answer go to the agent as points too: you are not asked them. The new run's second review starts afresh, without the earlier findings. When the review approves, the commit is handed over first. After three runs started by other writers' feedback, the item asks you before each further batch: **Send it to the agent** or **Leave it**. Your own feedback is never capped. The item's budget still applies.

**On a feature**, feedback that arrives while it works is held in the same way. Your feedback starts a re-plan. Another writer's feedback asks you first: **Plan a fix** or **Leave it**. The planner keeps completed subtasks as they are and adds fix subtasks. You approve the revised plan before anything runs. A feedback re-plan does not use up your own revisions of the plan. The fix may use the budget the feature has left. If that cannot cover another subtask, the question offers only **Leave it**. A feature that already has six subtasks does not take feedback. In both cases, file the fix as a new item.

**Not taken.** Feedback is not taken on a failed, done or cancelled item, on a subtask's own work, or after its machine was removed.

**On GitHub**, a taken comment gets a 👀 reaction. Reviews cannot take reactions. The item's comment on the pull request says which run works on the changes. At the next handoff, Windlass asks each writer whose change request it took to review again. Windlass never replies to people who do not count.

**On the item's page**, **From GitHub** lists each batch: who wrote it and when, the file and line, a link to it on GitHub, and what happened to it. A batch is **Taken** into a run, **Held** while a run works, **Waiting** while comments collect, **Needs you** when it asks first, or **Not taken** with the reason. Feedback from people without write access shows as **Counted only**.

## Text from someone else

Some of what an item's agent reads is not yours. Some of it was written by other people:

- the issue, when someone else wrote it;
- feedback on the pull request from anyone but you;
- in a feature, either of these as its subtasks inherit them.

The rest comes from the item's own run:

- CI's logs, when CI fails;
- the second reviewer's findings, and, for the reviewer, the builder's report;
- in a feature, the reports of other subtasks.

The agent is told in its prompt that all of this is quoted data, not instructions. The item's page and the session's timeline name each source, for example "CI logs of 1a2b3c4" or "issue #42 by @someone".

On most profiles Windlass is told too, with the turn that carries the text and with where it came from. From that turn on, the session counts as tainted. A command that would use the network or run outside Windlass's sandbox asks first, and so does a tool that could send data out. Nobody is there to answer in an item's turn, so such a call is refused, and the timeline says why. Edits in the workspace, commands inside the sandbox, and the platform's own tools (report, push) still work. The session stays tainted until the item ends.

Your MCP servers set to run without asking lose that setting in an item once its session is tainted, also part way through a turn. Their calls are then refused. Windlass taints a session for many reasons, among them the first result of an MCP server that is not marked `untrusted: false`.

Your own words are never marked: an item you wrote, your notes, your answers to the agent's questions, and your feedback on GitHub.

What a turn with such text does depends on the item's profile:

| Profile | Text from the run (CI logs, findings, reports) | Text from someone else (issue, feedback) |
|---|---|---|
| Docker + Windlass sandbox, E2B + Windlass sandbox | Windlass is told. Commands run as before: in its sandbox, without network. | The same. |
| E2B, before the sandbox check | Windlass is told. A command Windlass can't sandbox is refused, as before. | The same. |
| E2B, microVM only | Windlass is told. Commands move into its sandbox: no network, and nothing written outside the workspace. | The same. |
| Docker, hardened | Windlass is not told: it can't sandbox commands there, so it would refuse every one. The text goes labelled only, the timeline says so once, and commands run as on any turn, with the container's network. | The turn does not start. The item asks you, naming the text. **Run it anyway** sends that turn labelled only, as for text from the run: Windlass is not told, so the agent's commands run outside Windlass's sandbox, with the container's network and the session's access token, and a command the text talked it into is not stopped. Later turns of the item, and its subtasks, that carry no other text from someone else go the same way. Text from someone new asks again. Or file the work again on **Docker + Windlass sandbox**, or give up. |

**Claude Code and OpenCode** can't be told which text came from someone else. They get the same labelled prompt, the timeline says once that the text went as labelled text only, and they still run every command without asking, with network. Read an issue someone else wrote before you start an item on them.

A sandbox whose Windlass is older than 0.6.0 also gets labelled text only, and its timeline says so once.

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

A subtask can request up to four slots on a runner that reports per-slot CPU and memory. Older runners support one slot per subtask. A feasible machine that is busy or offline can be approved, and the subtask waits for capacity.

The planner may ask you questions with the plan. It may also say that one item is enough. The item shows the planner’s reason and offers **Approve for one implementer** or **Ask for subtasks**.

The planner reads what you wrote about your machines under [Say when to use it](/docs/machines#say-when-to-use-it).

### Review and approve it

When the plan is ready, the item waits under **Needs you**: "Its plan waits for your approval." Its page shows **It asks you**, "Review the plan: N subtasks, X tokens of the Y the feature may spend", and the plan below it.

- Answer the plan's questions, if it has any.
- Change a subtask's budget: tokens, turns, working minutes and, on this platform, hosted minutes. You can also change where it runs, see [Placement](#placement), and which agent, model and effort it runs, see [Each subtask's agent](#each-subtasks-agent). **Allotted to subtasks** shows the proposed total against what the subtasks may share. Once children exist, it also shows their actual spend.
- Choose **Save as version N** to keep your changes, or **Discard changes**.
- Tick each subtask listed under **Agents that work without asking**, if there are any.
- Choose **Approve version N** to start the subtasks.
- Choose **Ask for a new plan** to have the planner try again, or **Give up**.

If approval is refused because the repository lacks checks or push CI, **Run as a single item** turns the feature into one ordinary item and starts it. The tokens spent on planning stay counted.

### Placement

Each subtask says where it **runs on**: the place the planner prefers and why, and, when it **needs** something of a place (CPUs, memory, screenshots, egress or tags), what. A subtask with no place runs where the feature does. The plan's **overflow** line says whether a subtask whose preferred machine is busy may run on one of the alternatives it lists.

The approval card lists, under **Where each subtask runs**, each subtask's place, the planner's reason, its alternatives, whether overflow is allowed and, for every place, whether the repository's secrets are sent there: **secrets sent** or **no secrets**. This platform always gets them; a machine gets them only while its **Send saved secrets** switch is on. The planner may have read an issue anyone could file, so check this before you approve.

While the plan is open you can change a subtask's place from your machines or this platform, its alternatives, and overflow, then save them with the budgets as the next version. A place the platform would refuse, for example a machine whose owner chose **Never** under [Let features use it](/docs/machines#let-features-use-it), or one without screenshots for a subtask that needs them, shows **can't place** and the reason. A refused approval shows the same reason under the subtask. A busy or offline machine is not refused: the subtask waits for it.

Once a subtask has its item, its row says where it **ran on** and why, for example "nas · 2 slots" and "Approved overflow from ‘studio’". When the feature waits for a machine, the next subtask's row says which machine and for what, for example "Waiting for 2 free slots on ‘studio’. 0 free now."

### Each subtask's agent

Each subtask says which **agent** it runs, on which model and effort. The planner may propose one for each subtask. A subtask it proposes nothing for runs Windlass on the feature's model and effort, as the planner itself does.

While the plan is open you can change each subtask's agent, model and effort. The menus offer only what the subtask's place offers:

- **This platform** runs Windlass, on any model of your account.
- **A machine of yours** also offers Claude Code and OpenCode where its runner reports them signed in. One that is not signed in is listed but can't be chosen. The models and efforts are the ones the machine reported for that agent.

A subtask on Claude Code or OpenCode runs in the machine's hardened container, on its own model and effort. It never takes the feature's Windlass model: with no model chosen, it runs the agent's default. A choice the place does not offer, for example an agent the machine does not have or a model it does not list, shows **can't place** and the reason, and approval is refused the same way. If the machine changes after approval, for example the agent is signed out, the subtask can't be placed when the feature gets to it, and the feature asks you with the reason.

**Works without asking.** Claude Code and OpenCode work without asking: they run every command and edit in their sandbox without asking you. Wherever such a subtask is shown, it says **works without asking**. The planner reads the item's text, which may come from an issue anyone could file. So its choice of such an agent never runs on approval alone: the approval card lists each such subtask under **Agents that work without asking**, and **Approve version N** stays unavailable until you tick every one. An approval sent any other way that does not name each one is refused. To run one on Windlass instead, choose **Windlass** for it and save.

**Budgets per agent.** A subtask's budget counts the way its agent's does. OpenCode's tokens count against the subtask's token budget, and an OpenCode turn that reports no tokens stops the subtask, because its budget can't be enforced. Claude Code runs on your Claude subscription: its tokens are shown, not counted, and the subtask's turns and working time bound it. Only counted tokens reach the feature's budget.

**Usage limits.** A subtask waits only for its own agent's usage limits. When Claude Code is at its limit on the preferred machine and overflow is allowed, the subtask can run on an approved alternative whose Claude Code account is not.

**Re-plans.** When the planner revises the plan after a subtask stops, each remaining subtask keeps the agent, model and effort you approved, whatever the planner proposes. Change it on the card if you want another.

### Budgets

By default a feature may spend three times what one item may, giving it 18,000,000 tokens, 42 turns, 12 hours of working time and 6 hours of hosted sandbox time. Before each planning turn, the factory checks a planning allowance of 25% of a Quick item across all planning turns. Part of the feature budget, 1,000,000 tokens and 4 turns by default, is kept for the summary and the review. A subtask gets at most what one item may, and at least 2 turns and a tenth of one item's tokens and times.

When a feature reaches its budget, it stops and asks you. **Raise the limit and go on** may raise each figure by at most one item's allowance at a time.

### Subtasks

Each subtask is a work item with its own page, which says **subtask of** the feature. It starts from the feature's branch, runs at its approved placement with its own agent, model and effort (the feature's Windlass model where it chose none), and has the subtask's budget. It is given its brief, its paths and the reports of the subtasks it waits for.

A subtask opens no pull request of its own. It pushes its branch, and joins the feature only when its checks pass and CI passes on its commit. The platform then moves the feature's branch forward to it. If the feature's branch moved meanwhile, the subtask rebases onto it and is checked again.

Subtasks are not listed on the Factory page unless they ask you something.

If a subtask fails or is cancelled, the planner revises the plan for the work left. Done subtasks stay as they are, and remaining ones keep their approved agent. You review and approve the revised plan again. A feature can be revised this way twice.

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
- **Ended**: done, failed or cancelled, folded away. Unfolded, they show 25 at a time, the newest filed first, each with the day it was filed. Choose **Show 25 more** for the next ones.

A repository's page shows that repository's open items the same way, with its ended ones folded under **Show N ended items**. The **Work items** table on **Usage** shows the cost of your open items and your 25 newest ended ones, and says how many older ended items the Factory page lists.

Filter it with **repo** and **from**: filed from the web, the API or a GitHub issue. The filters are kept in the address, as `?repository=` and `?from=`.

## Limits

When a Factory turn reaches a capacity limit, the item waits and shows the reason. GitHub intake checks its filing limits before it creates an item. The deployment operator can override these limits for your account, and the **Work items** section of the **Usage** page shows them. By default:

| Limit | Default |
| --- | --- |
| Daily model tokens across items and interactive sessions | Unlimited |
| Feature budget | 3× the per-item budget |
| Factory turns at once | 5, out of 6 agents working at once |
| Hosted sandboxes at once | 3 |
| Items in review before new ones wait | 6 |
| Tokens per item | 6,000,000 |
| Turns per item | 14 |
| Working time per item | 4 hours |
| Hosted sandbox time per item | 2 hours |
| Items filed from GitHub per day | 20 |
| Drafts from GitHub waiting | 20 |

When an item reaches its own budget of tokens, turns, working time or hosted sandbox time, it stops and asks you, for example "This item has used 6M of its 6M tokens." The operator’s item budget and feature multiplier apply to newly created items. See [Budgets](#budgets).

When you reach your daily model token cap, admitted turns finish their current Factory step. The next turn waits until 00:00 UTC. This also applies to Windlass on paired machines because it uses the same model sign-in. See [Daily model tokens](/docs/settings#daily-model-tokens).
