## The start composer

You start an agent from the field at the top of **Agents**, the home page. With a repository chosen in the rail, the field launches on that repository. The prompt comes first. Type what the agent should do in **What should an agent do?**, then adjust the choices under the field if you need to.

- Press <kbd>Enter</kbd> or choose **Launch** to create the agent and send the prompt.
- Press <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line.
- Choose **Create without sending it**, or press <kbd>Alt</kbd>+<kbd>Enter</kbd>, to create the agent and send nothing yet. With an empty field the link reads **Create without a prompt**.

You do not name the agent. The platform names it from its first prompt. You can rename it later from the list of agents.

A prompt can be up to 20,000 characters long. Over that, the field says how many characters you are over the limit.

The choices are one line under the field, in this order:

- **+**: the repository's setup command and secrets, once a repository is chosen.
- **agent**: the agent's logo, its name and model, and the effort as small bars, for example **Windlass gpt-6.1-sol**. Its menu holds the models and the effort.
- **where**: where it runs and the repository at its branch, for example **Hosted · harbor / main**. Its menu holds the place, the sandbox, the repository and the branch.
- **Options** (the sliders icon): the mode, and what the sandbox lets the agent's commands do.
- The **lock**: hover or focus it to read what the sandbox lets the agent's commands do. It turns into a warning sign when something is open, for example the network.
- **Launch**, with its menu.

On a phone the line keeps the logos, the repository's name and the icons, and each menu opens as a sheet. Press <kbd>Escape</kbd> to close an open menu.

## Choose the repository

The repository is the last row of the **where** menu, with its branch, for example `you/project` **at main**. Choose it to open the list.

- **Choose from GitHub** lists the repositories your GitHub connection covers. Type in **Search your repositories** to filter them, then pick a branch. The default branch is chosen for you.
- **Paste an address** takes a repository's https address, for example `https://github.com/you/project.git`.
- **No repository** starts the agent in an empty repository.

The repository is cloned at that branch when the sandbox is created. The work can come back as a pull request.

A repository marked **read only** is one you can read on GitHub but not push to. The agent can work on it, but no pull request can be opened.

> **Tip** Not seeing a repository? Under the list, **Not listed? Give the app access at GitHub:** links to each account's installation. Add the repository there, then reload the list.

## Choose where it runs

The **where** menu lists **Hosted** and, once you have paired one, your machines. It starts on the machine your last agent ran on, if that machine can still be used, and on **Hosted** otherwise.

- **This platform**: a sandbox the platform makes and controls. It counts against your daily sandbox time.
- **A machine of yours**: the runner on that machine makes the sandbox. The platform's limits do not apply.

A machine that cannot be used now is listed under **Listed, but not usable now**, with the reason. For example, its runner may be too old, or it may not have connected yet. See [Use your own machine](/docs/machines).

## Choose the agent and model

The **agent** control shows the agent's logo, its name, the model and the effort as bars, for example **Windlass gpt-6.1-sol**.

### The agent

There are four agents, each shown by its own logo. The row of logos at the top of the **agent** menu switches to another agent the place offers in one press, on that agent's default model.

- **Windlass** runs everywhere.
- **Claude Code** runs only on one of your machines whose runner offers it. It runs with your Claude subscription.
- **OpenCode** runs only on one of your machines whose runner offers it. It runs with the model providers you signed it in with, or OpenCode's free public models.
- **Codex** runs only on one of your machines whose runner offers it. It runs with the ChatGPT sign-in or API key you signed it in with on that machine.

Choose the machine under **where** first. Claude Code and OpenCode run in the hardened Docker profile only. They do not run the repository's checks; CI's result is on the pull request. The **agent** menu groups the models under each agent's name, with its sign-in state. An agent offered only on another machine of yours says "choose that machine first". Under **Terminal sign-in commands** are the commands that sign each one in.

On machines with the updated runner, Claude Code reads the repository’s `CLAUDE.md` and `.claude/` settings, skills and commands. New sandboxes start with bundled skills such as `/deep-research`, the plugin-authoring plugin, dynamic workflows and account skill and plugin sync turned off. The built-in tools for code-review findings and loop wakeups are disabled. Claude uses shorter tool descriptions and keeps the platform tools and their usual approvals.

See [Agents on your machine](/docs/machines#agents-on-your-machine) to set them up.

### The model

**Model** lists the models you can choose. The default one is marked **default**. For Windlass, these are the models of your ChatGPT plan, as the platform read them for your account. For Claude Code, OpenCode and Codex, they are the models the machine's runner reported: for OpenCode, those of the providers it is signed in with. Until the runner has reported them, the menu offers the agent's default model. With many models, type in **Filter models…** to find one. You can change the model with any later prompt.

### The effort

**Effort** sets how hard the model reasons. It is the last group of the **agent** menu, under the models, shown when the chosen model has levels: choose **default**, or one of the levels the chosen model offers. The **agent** control shows it as bars. The levels come from your plan, so they differ between models.

## Choose the mode

The mode sets what the agent may do without asking you. **Options**, the sliders icon, lists the modes of the agent you chose. A dot on it warns of a mode that runs commands without asking.

### Windlass modes

Windlass always has two modes. **Ask** is one. The other depends on the sandbox, and it is the default.

| Mode | What it does | Offered in |
| --- | --- | --- |
| **Ask** | Ask before writes, commands, network access and MCP calls. | Every sandbox |
| **Auto** | Use Windlass’s command sandbox and ask when needed. | Docker + Windlass sandbox, E2B + Windlass sandbox, E2B |
| **Full** | Allow commands to run directly in the sandbox machine. | Docker, hardened; E2B, microVM only |

### Claude Code modes

| Mode | What it does |
| --- | --- |
| **Manual** | Ask before using tools. |
| **Accept edits** | Allow file edits. |
| **Plan** | Plan the work before editing. |
| **Auto** | Automatically assess tool permissions. This is the default. |
| **Bypass permissions** | Run tools without permission prompts. |

Once the machine reports Claude Code's own list of modes, **Options** shows that list instead.

### OpenCode modes

OpenCode starts in **build**. Its modes are the ones OpenCode reports, for example **build**, which runs tools as OpenCode's permissions allow, and **plan**, which allows no edits. On Windlass, OpenCode asks you before it runs a command, edits a file or works outside the workspace.

### Codex modes

Codex's modes depend on the sandbox: **Container access** on Docker, hardened, and **Read-only** or **Workspace access** (the default) on Docker + Windlass sandbox. See [Codex sign-in](/docs/runner#codex-sign-in) for what each allows.

**Plan mode** is a separate choice in the session's composer, beside the effort and the model. With **Plan mode · on**, the next prompt asks Codex for a plan and it changes nothing. Set it back to **off** to have it do the work. It applies to a prompt that starts a turn, not to a message that steers a running one, and it can't be changed while a turn runs. It is not the work items' **Plan first**.

> **Careful** **Full** and **Bypass permissions** let the agent run commands without asking. Use them in a sandbox you trust with the repository and its secrets.

## Choose the sandbox

The sandbox sets where the agent's files live and its commands run. Choose it in the **where** menu: each place's row opens its sandboxes. Each choice shows what isolates it, outermost first, and three facts:

- whether it runs what the sandbox contains and refuses the rest, or runs every call without asking;
- whether commands can reach the network;
- whether commands can read the session's access token. Your ChatGPT sign-in itself is never in the sandbox. In a Claude Code or OpenCode session, commands can use the machine's login through the session's model relay, but cannot read it. Older runners may also expose the Claude setup token.

The **lock** in the line, and the foot of **Options**, say the chosen sandbox's facts in full. For Claude Code and OpenCode, they show the mode in place of the first fact. For OpenCode it then says **OpenCode relay** where commands have no other network, and **credentials on machine**: "Commands can use the OpenCode model relay. Provider credentials stay on the machine." For Claude Code it says **Claude relay only** where commands have no other network, and **Claude login via relay**, or **Claude login readable** on an older runner without a relay.

The sandboxes on offer depend on the platform and on the machine. Read [Sandboxes and security](/docs/security) for what each one protects. A sandbox that cannot be used is listed under **Listed, but not usable on this deployment**, with the reason.

## Defaults

A new agent starts from saved defaults, so you rarely need to change the choices. When a choice differs from the default, its menu offers **Back to the default**.

The platform takes each choice from the first of these that has one:

1. what you choose when you launch the agent;
2. the repository's default, in its settings;
3. your account's default, in **Settings**;
4. what your newest agent on that repository was launched with, or your newest agent overall if none is on it;
5. the platform's own default.

**Where it runs, the agent and the mode** have no saved default. They start where your last agent started, on any browser, even if you deleted that agent. A work item does not count. If that machine is gone or cannot be used, or it no longer offers that agent, the agent starts on **this platform** with Windlass, and the control shows a warning dot whose menu says why.

See [Settings, usage and limits](/docs/settings) to save defaults.
