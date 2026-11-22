## The session page

Each agent has its own page, at `/agents/<id>`. The bar at the top shows its title and its status. When it runs on one of your machines, it also says which one.

The page has two parts. The timeline of the work takes most of it. The side panel holds the details: the session, its sandbox, its tokens or usage, and its changes.

If the agent asks you something while its tab is in the background, the tab's title starts with **(?) Needs you**.

### Statuses

| Status | Meaning |
| --- | --- |
| **idle** | Nothing is running. Send a prompt to start a turn. |
| **starting** | The sandbox is getting ready. |
| **working** | A turn is running. |
| **needs you** | A question waits for your answer. |
| **stopping** | The turn is being stopped. |

When a turn ends, its outcome is one of **done**, **done, checks unresolved**, **failed**, **stopped**, **interrupted** or **error**.

## The timeline

The timeline shows everything the agent does, live: your prompts, its reasoning (**thinking**, then **thought**), its tool calls and its answers. Each tool call shows its state, such as **running**, **done**, **failed** or **refused**.

Tool calls that finished one after another are folded into one line that says what they did, for example **Read 4 files, searched twice and ran 1 command**, with how many failed. Choose the line to see each call, and a call to see its input and output. A call that is running, asks you something, was refused or was answered stays on its own line, as do subagents and pushes.

Above the field, a status line says what is happening, for example **running `bun test` · step 3**, with a timer. If you scroll up, **Jump to latest** takes you back to the end. When you hide the side panel, the timeline stays in the middle of the page.

At the end of each turn, a summary line gives the outcome, the number of steps, the time it took and the files it changed. The tokens it used are folded behind **tokens** at the end of that line: choose it, or hover it, to see them. For Claude Code the line gives how full the context is and the cost so far instead. The session panel shows the tokens too.

You can copy a prompt, an answer (as Markdown) or a code block with the copy button beside it.

## Send a prompt

When the agent is **idle**, type in **Tell the agent what to do** and press <kbd>Enter</kbd>, or choose **Send**. <kbd>Shift</kbd>+<kbd>Enter</kbd> makes a new line.

A finished session is not closed. Send another prompt to go on from where it stopped. There is no separate resume step.

You can change the model, effort and mode before each prompt. While a turn runs, only the mode can be changed, and the change applies from the next prompt.

## Steer a running agent

While the agent works, the field says **Steer it: add to or change what it is doing**. Type a message and press <kbd>Enter</kbd>, or choose **Steer**. The agent reads it after its current step. Your message is marked **steer** in the timeline.

- With **Claude Code**, if the turn cannot take the message yet, it is held. It shows **Sent when this turn ends.** Choose **Take it back** to remove it.
- With **Windlass**, if the turn cannot take the message, the field says so and keeps your text: "Your message is still here."

## Answer the agent's questions

In some modes the agent asks before it acts. The question appears at the tool call in the timeline, and in a dock above the field. The usual question is **May this call run?**

Choose one of the answers it offers. With Windlass, you can also decline with a note: choose **add a note**, then say why, or what to do instead.

A question waits 10 minutes. A countdown shows **declines in** and the time left. If nobody answers in time, the platform declines for you, and the timeline says "Nobody answered … within 10 minutes, so it was declined." The agent is told, and goes on.

The agent asks one question at a time.

## Stop

Choose **Stop**, beside the field, to stop the running turn. It shows **Stopping** while it works. The conversation and the files stay. Send a prompt to go on.

With Windlass, you can also stop a single tool call: choose **Stop this call** on it.

## The side panel

### Session and sandbox

**Session** lists the title, id, state, agent, model, mode, number of turns, repository and when it was created. **Sandbox** names the sandbox and gives three facts: what the agent may run without asking, what its commands can reach on the network, and whether they can read the session's access token. On one of your machines, the network fact follows the machine's [network mode](/docs/machines#network-access). **How it is held** lists the layers that isolate it.

### Tokens and usage

For Windlass, **Tokens** counts input, cached, cache share, output, reasoning and calls, for the whole session and for the last turn. **Cache per call** charts how much of each of the last 40 calls came from the cache.

For Claude Code, **Usage** shows how full the context is, for example "38% used", and the cost so far when Claude Code reports it.

### Changes

**Changes** lists the files that differ from the last commit, each with its git status: modified, added, deleted, renamed or untracked. Choose **View the diff** to read the whole diff. You can copy the whole diff, or one file's.

## Open a pull request

The **Pull request** section appears for an agent on a repository from your GitHub connection.

1. Choose **Open pull request**.
2. Enter a **Title** and, if you like, a **Description**. The title starts as the agent's title. The description starts as the agent's last answer.
3. Choose **Commit, push and open**.

The platform commits the changes, pushes a branch named `windlass/<title>-<id>` and opens the pull request into the branch the agent started from. It is not opened as a draft. Your GitHub access is never given to the agent's sandbox: the platform does the push itself.

After that, the button is **Push changes**. Use it to push new work to the same pull request, with a **Commit message**.

The platform does not push while the agent is working. Wait for the turn to end.

### When the agent opens it

The agent can also ask to publish. It then asks **Allow the agent to open a pull request?**, or **Allow the agent to push to pull request #N?** Answer **Allow once**, **Don't allow**, or, in the Windlass sandbox profile, **Allow for this session**.

In the Windlass sandbox profile, the panel offers **Let the agent publish without asking**. In other profiles you are asked each time.

> **Note** Before it pushes, the platform looks for the values of your saved secrets in the changes. If it finds one, nothing is pushed, and it names the files.

The agent can also push its work to the session's branch, and fetch the branch it started from, without asking you. It pushes only to the session's own branch, never to the default branch. A commit someone else pushed to that branch is never pushed away: the push is refused, and the agent is told to fetch and merge it first.

### What was verified

Every pull request the platform opens ends its description with a section, **What was verified**. The platform writes it from what Windlass recorded of the checks, not from what the agent wrote, and writes it again with every push. Text you add elsewhere in the description stays.

The section says:

- how the checks of the agent's last turn ended, and each check's name, command, whose it is, result and time;
- the end of the output of a check that did not pass;
- which of your checks did not run, and why;
- when nothing was verified, why: for example, no checks are set for the repository;
- under **To look at**, what a reviewer may want to check: test files deleted or renamed away, tests newly skipped, a change to what the checks run, a check's command that now ignores an exit status, or files changed after the checks last ran.

It ends by saying that it is not a review. A push the agent makes during its turn comes before that turn's checks, so the section first says that what the turn changed had not been checked yet. The platform writes it again once the turn has ended.

For a session on one of your machines, the section adds that the checks ran on that machine, and that this is what the machine reported.

## The repository's setup command

Where the repository has a [setup command](/docs/settings#setup-command), it normally runs once in each new sandbox, after the clone and before the agent's first turn there. The timeline shows the command, what it prints as it runs, how it ended and how long it took. **Stop** stops it, and the turn with it.

Hosted Docker and supported machine runners can reuse Git objects from your earlier clones of the same connected repository on that machine. GitHub still supplies the branch head at launch. Each session keeps its own complete clone, including after the machine evicts the mirror.

On deployments with prepared Docker sandboxes enabled, a successful setup on the repository’s default branch can be saved before the first agent turn. Setup must take at least 30 seconds and receive no repository secrets. A later session on the same machine can reuse your snapshot when its dependency files, setup command, sandbox image, and platform match. Subtasks and reviewers can reuse a prepared sandbox. Only the original builder or a personal session can save one.

On a match, the platform fetches and checks out the session’s source and skips setup. The timeline and the agent’s first prompt identify the base commit that produced the build outputs. The agent can rebuild them if the source has changed.

If setup fails or runs out of time, the session goes on. The agent is told before its next prompt, with the command, how it ended and the last 20 lines it printed.

You can change the command in the side panel, under **Setup command**. A change applies to sandboxes made after it. A sandbox that already has its clone is not set up again.

## MCP servers of the repository

A repository can name MCP servers in `.windlass/config.json`. Windlass does not start them by itself, because opening a repository must not run a command the repository chose. Before a turn, the agent asks you: **Start this project's MCP server "…"?** The question shows the server's command with every argument, or its address, and the file that defines it. It also says what the server can do: it runs outside Windlass's sandbox around commands, so it has the network and can read the session's access token.

- **Start it for this project** starts it. The agent has its tools from this turn on.
- **Not now** leaves it stopped. Your next message asks again.

A question nobody answers within 10 minutes counts as **Not now**. If a server's definition reads a secret, the question says which saved secret approving hands over, or which secret to save if it is not set.

Your approval is remembered for 30 days, for that repository and exactly that definition. A changed definition is asked about again. A changed script that the definition runs is not.

The side panel's **MCP servers** section lists each server with its command, its state in the last turn and, where an approval is remembered, until when, with **Forget**. A server that waits because you said **Not now** has **Approve…** there; it starts with the next turn.

> **Note** Forgetting holds for new sessions and new sandboxes. A sandbox where the server already started goes on starting it, and a running server is not stopped. On a Docker platform, Windlass's own approval holds in all your sessions with the Windlass sandbox, since they share its data. A hardened Docker sandbox has Windlass data of its own, so there the platform's approval is what your other sessions go by.

A repository's hooks do not run, and its language servers do not start.

## Sandboxes after the work

A sandbox is paused 10 minutes after its last turn. A paused sandbox uses no sandbox time. On this platform it is removed after 7 days without use. The timeline stays either way. If the sandbox is gone, the next prompt starts a new one.

### When a sandbox is replaced

A new sandbox has a fresh workspace. The platform clones the repository at the branch the session started from and runs its setup command. Where the session's work was pushed, it then puts the workspace on the session's branch as GitHub has it. What was only in the old sandbox is lost. The agent is told with its next prompt.

Where the platform keeps a copy of the agent's memory of the conversation, it restores it, and the timeline says "Restored the agent's memory of the conversation into the new sandbox." Otherwise the agent starts without it, and the timeline says so. On Docker, the agent's memory outlives the sandbox, except in a hardened Docker sandbox: its Windlass data is its own, so that other sessions' commands cannot read it, and it goes with the sandbox.

On one of your machines, a sandbox is not removed after a time. It goes when you delete its agent, when you remove the machine with its sandboxes, or when you prune the runner.

On this platform you can keep up to 5 sandboxes at once. To free one, go to **Usage**, find it under **Sandboxes you keep** and choose **Free…**. See [Settings, usage and limits](/docs/settings#usage).

## Rename or delete an agent

On the list of agents, each row has **Rename** and **Delete**. Deleting asks first: **Delete this agent?**

An agent that works for a work item cannot be deleted while the item has it. Cancel the item instead.

Deleting an agent on one of your machines records that its sandbox must be removed, and the runner removes it now or when it is next online. If that record cannot be written, the delete is refused: "The agent could not be deleted: its machine's record of the sandbox to remove could not be written. Try again in a moment."
