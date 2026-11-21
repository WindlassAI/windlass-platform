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

Above the field, a status line says what is happening, for example **working · step 3**, with a timer. If you scroll up, **Jump to latest** takes you back to the end.

At the end of each turn, a summary line gives the outcome, the number of steps, the time it took, the files it changed and the tokens it used. For Claude Code it gives how full the context is and the cost so far.

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

## Sandboxes after the work

A sandbox is paused 10 minutes after its last turn. A paused sandbox uses no sandbox time. On this platform it is removed after 7 days without use. The timeline stays either way. If the sandbox is gone, the next prompt starts a new one.

On one of your machines, a sandbox is not removed after a time. It goes when you delete its agent, when you remove the machine with its sandboxes, or when you prune the runner.

On this platform you can keep up to 5 sandboxes at once. To free one, go to **Usage**, find it under **Sandboxes you keep** and choose **Free…**. See [Settings, usage and limits](/docs/settings#usage).

## Rename or delete an agent

On the list of agents, each row has **Rename** and **Delete**. Deleting asks first: **Delete this agent?**
