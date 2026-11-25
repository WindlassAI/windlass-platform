## What Windlass is

Windlass is a coding agent. On this platform it runs in a sandbox you choose, on one of your GitHub repositories or in an empty one. You see each file it reads, each command it runs and what the work cost. When it is done, you can take its changes as a pull request.

You can run an agent in two places:

- **Hosted.** Windlass runs the agent for you. Its workspace uses hosted time while running.
- **My machines.** Pair a computer with Docker to run agents there. Runs on your machines use no hosted time.

Where the platform offers it, the **Factory** goes one step further. You file a work item, and an agent takes it from the task to a pull request on its own: it works, runs your checks, waits for CI and hands the pull request to you. For a bigger feature, choose **Plan first**. The planner can split it into subtasks that come back as one pull request per repository. You merge by default.

## Where to begin

1. [Getting started](/docs/getting-started): get access, sign in and connect a repository.
2. [Start an agent](/docs/start-an-agent): write the prompt and choose where and how it runs.
3. [Work with a session](/docs/sessions): follow the work, steer it and open a pull request.

If you want agents to run on your own hardware, read [Use your own machine](/docs/machines). If you have no spare computer, you can [run agents on a cheap cloud VM](/docs/cheap-vm). To know what each sandbox protects, read [Sandboxes and security](/docs/security).

> **Tip** Press <kbd>/</kbd> on any page of these docs to search them.
