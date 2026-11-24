## What Windlass is

Windlass is a coding agent. On this platform it runs in a sandbox you choose, on one of your GitHub repositories or in an empty one. You see each file it reads, each command it runs and what the work cost. When it is done, you can take its changes as a pull request.

You can run an agent in two places:

- **This platform.** The platform makes the sandbox and controls it. It counts against your daily sandbox time.
- **One of your machines.** A small program, the runner, makes the sandbox on your own Linux machine with Docker. The platform's limits do not apply there. On a machine you can also run Claude Code or OpenCode instead of Windlass.

Where the platform offers it, the **Factory** goes one step further. You file a work item, and an agent takes it from the task to a pull request on its own: it works, runs your checks, waits for CI and hands the pull request to you. For a bigger feature, choose **Orchestrate**: a planner splits it into subtasks you approve, and they come back as one pull request. Merging always stays yours.

## Where to begin

1. [Getting started](/docs/getting-started): get access, sign in with ChatGPT and connect GitHub.
2. [Start an agent](/docs/start-an-agent): write the prompt and choose where and how it runs.
3. [Work with a session](/docs/sessions): follow the work, steer it and open a pull request.

If you want agents to run on your own hardware, read [Use your own machine](/docs/machines). If you have no spare computer, you can [run agents on a cheap cloud VM](/docs/cheap-vm). To know what each sandbox protects, read [Sandboxes and security](/docs/security).

> **Tip** Press <kbd>/</kbd> on any page of these docs to search them.
