## The start composer

You start an agent from the field at the top of **Agents**, the home page, or from **New agent** on a repository's page. The prompt comes first. Type what the agent should do in **What should it do?**, then adjust the choices under the field if you need to.

- Press <kbd>Enter</kbd> or choose **Launch** to create the agent and send the prompt.
- Press <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line.
- Choose **Create without sending it**, or press <kbd>Alt</kbd>+<kbd>Enter</kbd>, to create the agent and send nothing yet. With an empty field the link reads **Create without a prompt**.

You do not name the agent. The platform names it from its first prompt. You can rename it later from the list of agents.

A prompt can be up to 20,000 characters long. Over that, the field says how many characters you are over the limit.

The choices under the field are chips, in this order: **repo**, **on**, **agent**, **mode** and **sandbox**. On a narrow screen, the later ones fold behind **⋯ N more**, where N is how many are folded. Press <kbd>Escape</kbd> to close an open chip.

## Choose the repository

The **repo** chip shows the repository and branch, for example `you/project @ main`.

- **Choose from GitHub** lists the repositories your GitHub connection covers. Type in **Search your repositories** to filter them, then pick a branch. The default branch is chosen for you.
- **Paste an address** takes a repository's https address, for example `https://github.com/you/project.git`.
- **No repository** starts the agent in an empty repository.

The repository is cloned at that branch when the sandbox is created. The work can come back as a pull request.

A repository marked **read only** is one you can read on GitHub but not push to. The agent can work on it, but no pull request can be opened.

> **Tip** Not seeing a repository? Under the list, **Not listed? Give the app access at GitHub:** links to each account's installation. Add the repository there, then reload the list.

## Choose where it runs

The **on** chip appears once you have paired one of your machines. It starts on the machine your last agent ran on, if that machine can still be used, and on **this platform** otherwise.

- **This platform**: a sandbox the platform makes and controls. It counts against your daily sandbox time.
- **A machine of yours**: the runner on that machine makes the sandbox. The platform's limits do not apply.

A machine that cannot be used now is listed under **Listed, but not usable now**, with the reason. For example, its runner may be too old, or it may not have connected yet. See [Use your own machine](/docs/machines).

## Choose the agent and model

The **agent** chip shows the agent, the model and the effort, for example **Windlass · default model**.

### The agent

There are two agents:

- **Windlass** runs everywhere. Work items always use it.
- **Claude Code** runs only on one of your machines whose runner offers it. Choose that machine under **on** first. It runs with your Claude subscription, in the hardened Docker profile only. It does not run the repository's checks; CI's result is on the pull request.

See [Claude Code on your machine](/docs/machines#claude-code-on-your-machine) to set it up.

### The model

**Model** lists the models you can choose. The default one is marked **default**. For Windlass, these are the models of your ChatGPT plan, as the platform read them for your account. You can change the model with any later prompt.

### The effort

**Effort** sets how hard the model reasons. Choose **default**, or one of the levels the chosen model offers. The levels come from your plan, so they differ between models.

## Choose the mode

The mode sets what the agent may do without asking you. The **mode** chip lists the modes of the agent you chose.

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

Once the machine reports Claude Code's own list of modes, the chip shows that list instead.

> **Careful** **Full** and **Bypass permissions** let the agent run commands without asking. Use them in a sandbox you trust with the repository and its secrets.

## Choose the sandbox

The **sandbox** chip sets where the agent's files live and its commands run. Each choice shows what isolates it, outermost first, and three facts:

- whether it runs what the sandbox contains and refuses the rest, or runs every call without asking;
- whether commands can reach the network;
- whether commands can read the session's access token. Your ChatGPT sign-in itself is never in the sandbox. Claude commands can use the machine’s login through the session’s model relay. Older runners may also expose the setup token.

The sandboxes on offer depend on the platform and on the machine. Read [Sandboxes and security](/docs/security) for what each one protects. A sandbox that cannot be used is listed under **Listed, but not usable on this deployment**, with the reason.

## Defaults

A new agent starts from saved defaults, so you rarely need to change the chips. When a choice differs from the default, the chip offers **Back to the default**.

The platform takes each choice from the first of these that has one:

1. what you choose when you launch the agent;
2. the repository's default, in its settings;
3. your account's default, in **Settings**;
4. what your newest agent on that repository was launched with, or your newest agent overall if none is on it;
5. the platform's own default.

See [Settings, usage and limits](/docs/settings) to save defaults.
