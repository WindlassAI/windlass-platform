### Acceptance criteria
Lines a work item's agent is given, which the verdict lists for you to check. No machine checks them.

### Access token
The short-lived ChatGPT token a Windlass turn gets. Each token lasts about an hour from issue. The platform replaces it during a long turn. The sign-in stays on the platform.

### Agent
A coding agent working on one task, with its own conversation and sandbox. Each has its own page, at `/agents/<id>`. Also called a session.

### Budget
What a work item may spend before it asks you for more: one figure of cost-weighted tokens, where an input token read from the prompt cache counts as a tenth, and on this platform its hosted sandbox time. Used up, the item pauses and keeps its work. See [When the budget is used](/docs/factory#when-the-budget-is-used).

### Checks
Commands you set for a repository. Windlass runs them before it calls a turn done, and sends the agent back with what fails.

### Claude Code
Anthropic's coding agent. On Windlass it runs only on your own machines, with your Claude subscription.

### Credential relay
The container on your machine that holds an agent's login and forwards the agent's model requests with it, so the login is never inside the agent's container.

### Docker + Windlass sandbox
A Docker profile in which Windlass sandboxes every command again: the agent's commands have no network and cannot read the access token. Setup ends before handoff. Approved local MCP servers can read the token. Its ID is `docker-windlass-sandbox`.

### Docker, hardened
A Docker profile in which commands run directly in the container, with network, under Docker's default seccomp and AppArmor profiles. Its ID is `docker-hardened`.

### Effort
How hard the model reasons. The levels come from the model.

### Factory
The page that lists your work items, and the pipeline that carries them from a task to a pull request.

### Feature
An orchestrated work item: a planner splits it into subtasks you approve, and they land together as one pull request.

### GitHub App
The Windlass App you install on your GitHub accounts. The platform acts as its installation to clone, push and open pull requests.

### Harness
Which agent runs: Windlass, Claude Code or OpenCode.

### Machine
A Linux machine of yours with Docker, paired with your account, where agents can run.

### MCP server
A program that gives an agent more tools. You can add your own in **Settings**. A repository can name its own, and the agent asks before it starts one.

### Mode
What the agent may do without asking you: for Windlass, **Ask**, **Auto** or **Full**; for Claude Code and OpenCode, their own modes.

### OpenCode
An open-source coding agent. On Windlass it runs only on your own machines, with the model providers you sign it in with.

### Pairing code
The `XXXX-XXXX` code the runner prints, which you enter on the Machines page to pair the machine. It lasts ten minutes.

### Network mode
What the agents' commands on one of your machines can reach: `restricted`, `open` or `none`. Set with the runner's `--egress`.

### Planner
The agent that writes a feature's plan. It reads but cannot write, edit or run commands.

### Profile
A kind of sandbox, with what isolates it and what it allows.

### Runner
The program that runs on your machine, in the `windlass-runner` container. It connects out to the platform and makes the sandboxes there.

### Sandbox
Where an agent's files live and its commands run: a container or a microVM of its own.

### Sandbox time
The time your sandboxes on this platform run. You have a daily allowance.

### Second review
A second agent that reviews a work item's pushed commit against the task, where the platform offers it.

### Secret
A value you save for a repository or your account, given to the setup command, MCP servers or the agent's commands as an environment variable.

### Setup command
A command that runs once when a repository's workspace is created, before the agent starts.

### Subtask
One part of a feature's plan. It runs as a work item of its own, under the feature.

### Steer
A message you send to an agent while it works. It reads it after its current step.

### Turn
One run of the agent, from your prompt to its answer.

### Verdict
What a handed-over work item's evidence says: CI, your checks and what was seen in the changes. It never rests on the agent's words.

### Windlass
The coding agent the platform runs, and the platform itself.

### windlass/verified
The GitHub check run that publishes a Factory verdict for one commit. Its details link opens the evidence for the item's owner.

### Work item
A task that an agent carries on its own from your words to a reviewed pull request.
