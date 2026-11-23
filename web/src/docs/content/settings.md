## Account settings

Open the account menu and choose **Settings**. What you save here holds for every agent of yours, whatever the repository. What you save for one repository is under **Saved settings** when you choose it in **Agents**.

### Defaults for new agents

Choose a default **Sandbox** and **Model**, or **No default**. They save as soon as you choose. A new agent starts from these where its repository has no default of its own. See [Defaults](/docs/start-an-agent#defaults) for the full order.

**Where it runs, agent and mode** shows where your last agent started. A new agent starts there too. Choose **Forget** to start the next one on this platform with Windlass.

### MCP servers

Add servers of your own with **Add…**. They give every agent of yours their tools, whatever the repository. Windlass starts them without asking first. Windlass asks before a call of an MCP tool. Tick **Run this server's tools without asking** to have the platform answer for you, in every agent of yours. Each call still shows in the timeline.

> **Careful** With this on, nothing stops to ask if something the agent read talks it into misusing a tool of this server. Such a tool runs outside the command sandbox, with network access.

A change holds from each agent's next turn. An account can keep 20 servers. A server's name can be up to 64 characters long.

### Secrets

Account secrets go to MCP servers by default: your own, and a repository's once you approve it. You can also give one to the agent's commands. A repository's setup command never gets an account secret. An account can keep 50. See [Secrets](/docs/security#secrets) for where each one goes.

### Machines

Where the platform offers machines, this section links to **Your machines**. See [Use your own machine](/docs/machines).

### API tokens

Where the platform offers work items, you can make up to 20 API tokens for scripts that file and read your work items. See [From the API](/docs/factory#from-the-api).

A token works until you revoke it. Choose **Revoke token** to stop it at once. Work items it filed stay.

### Sign out everywhere

**Sign out everywhere** signs you out on every device, including this one. **Also revoke all API tokens** is checked by default. Clear it to keep your scripts working with their existing tokens. Running agents continue, and paired machines keep working. On the **Machines** page, you can [remove a pairing](/docs/machines#remove-a-machine).

## Repository settings

Choose a repository in the rail of **Agents**, then **Saved settings**. Each section has its own address, for example `/repositories/<id>/settings#checks`.

### Defaults for new agents

The sandbox and model a new agent on this repository starts from. You can still change them when you launch an agent. An agent that exists keeps what it was launched with.

### Screenshots

**Take screenshots for work items** lets builders and reviewers attach pictures of the app to their work item reports. It is off by default. When it is on, new work item sandboxes include a browser where available.

### Setup command

A command that runs once when a workspace is created for the repository, before the agent starts: for example, to install dependencies. It runs with network access, outside the agent's command sandbox, for at most 10 minutes. Every repository secret is passed to it.

It can be 2,000 characters long. Put a longer one in a script in the repository and run that. A change applies to workspaces created after it: an agent that already has one is not set up again.

### Checks

Commands that Windlass runs before it calls a turn done, in the agent's own sandbox. It sends the agent back with what fails, three times at most. A pull request the platform opens says which checks ran and how each ended. Without checks, a pull request says that nothing was verified.

| Limit | Value |
| --- | --- |
| Checks per repository | 20 |
| Name | 64 characters |
| Command | 2,000 characters |
| Time per check | 1 to 3,600 seconds, 120 by default |
| File patterns | 20, of up to 200 characters each |

Agents on the repository have new checks from their next turn.

### Network

Where the platform limits its hosted sandboxes' network (**Restricted**, see Security), the repository's agents reach the model API, GitHub, the bucket that keeps their memory and the hosts the platform allows. Here you can let them reach more, for every hosted agent on the repository. It changes nothing for agents on your own machines. A [cross-repo feature](/docs/factory#cross-repo-features)'s own agent, which plans over both repositories, reaches what each one's list allows; each of its subtasks gets its own repository's.

**Presets** are named sets of hosts, chosen with a checkbox each. A preset the platform allows for every sandbox already is shown checked and cannot be changed here.

| Preset | For | Hosts |
| --- | --- | --- |
| npm registry `@npm` | npm, pnpm, Yarn and Bun packages | `registry.npmjs.org`, `registry.yarnpkg.com` |
| PyPI `@pypi` | pip, uv and Poetry packages | `pypi.org`, `files.pythonhosted.org` |
| GitHub downloads `@github` | Release assets, raw files and archives | `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `release-assets.githubusercontent.com` |
| crates.io `@crates` | Cargo packages | `crates.io`, `index.crates.io`, `static.crates.io` |
| Go module proxy `@go` | Go modules and their checksums | `proxy.golang.org`, `sum.golang.org` |
| nodejs.org `@node` | Node.js downloads, and the headers node-gyp builds native addons with | `nodejs.org` |
| Playwright browsers `@playwright` | What `playwright install` downloads, except Chromium on x86_64, which comes from Google Cloud Storage (`@gcs`) | `cdn.playwright.dev`, `playwright.download.prss.microsoft.com` |
| Google Cloud Storage `@gcs` | Every public Google Cloud Storage bucket, anyone's. Playwright's Chromium for x86_64 comes from it | `storage.googleapis.com` |
| Prisma engines `@prisma` | The engines Prisma downloads when it is installed | `binaries.prisma.sh` |
| Debian packages `@debian` | Debian's apt sources | `deb.debian.org`, `security.debian.org` |
| Ubuntu packages `@ubuntu` | Ubuntu's apt sources; the sandbox runs Ubuntu | `archive.ubuntu.com`, `security.ubuntu.com`, `ports.ubuntu.com` |

`@gcs` is a preset of its own because `storage.googleapis.com` serves every public Google Cloud Storage bucket, not only Playwright's: allowed, it lets a command send to or fetch from any of them. The page says so wherever you can allow it.

- **Hosts** are exact names, such as `registry.example.com`: no addresses, ports, paths or wildcards. A repository can allow 40 hosts, presets counted by their hosts, and fewer where the platform's own list leaves less room.
- **Asked for by its agents** lists the hosts a command in one of the repository's sandboxes looked up and could not reach. Choose **Allow** or **Dismiss**. The agent and the repository's scripts choose what a command looks up, so allow only a host you expect. The list keeps 30 hosts; once it is full, a new one is not added, and the agent's timeline says so, until you allow or dismiss some.
- **Look for hosts in the repository** reads the manifests, lockfiles, install scripts and CI files of the default branch, and the setup command, and lists the presets and hosts they name that the sandboxes cannot reach yet, each with where it was found, for example "package.json scripts.postinstall". Nothing is allowed until you choose **Allow** for it: a file in a repository can name any host.

A change applies to each agent from its next turn. **Allow for this repository** in an agent's timeline applies at once to that agent's sandbox while a turn is running in it, and otherwise from its next turn. Only you can change this list: it is saved with your settings for the repository.

### Secrets

Repository secrets go to the setup command, and to the MCP servers the repository names, where their definition reads it as `${NAME}`. Choose **Also the agent's commands** to give one to the agent's commands too.

- A repository can have 50 secrets, and you can have 2,000 over all your repositories.
- A name uses letters, digits and underscores, does not start with a digit, and is up to 64 characters long. Names the sandbox or Windlass relies on are refused, such as `PATH`, `HOME` or names starting with `WLP_`.
- A value is at least 8 characters long, so it can be found and taken out of what the platform shows, and at most 16,384 bytes. It can have several lines.
- A saved value cannot be shown again. Leave the field empty to keep it.

### MCP server approvals

An agent asks before it starts an MCP server that the repository names: **Start this project's MCP server "…"?** When you choose **Start it for this project**, the approval is remembered for 30 days. This section lists them. Choose **Forget** to remove one.

### Delete what is saved

**Delete what is saved…** removes the setup command, the checks, the network list and its requests, the secrets, the defaults and the remembered approvals of the repository at once. Screenshots return to off. The repository's agents are not deleted. This cannot be undone, and a secret's value cannot be read back, so keep a copy of any you still need.

## Usage

The **Usage** page shows your effective limits, model tokens, hosted sandbox time and kept sandboxes. The deployment operator sets account limits.

### Daily model tokens

Input and output count once for hosted agents and for Windlass on a paired machine, which uses the model sign-in supplied by the platform. Claude Code and OpenCode on your machine use your own local subscription and are excluded. The allowance resets at 00:00 UTC. If a cap is set and you reach it, running turns finish, new Factory turns wait and new interactive prompts show when you can try again.

### Sandbox time

Sandbox time is the time your agents' sandboxes run: while an agent works, and for a short while after. A paused sandbox uses none. The default is 2 hours of sandbox time a day, for all your sandboxes together. The allowance is whole again at 00:00 UTC.

**Sandbox time today** shows what is counted, what is held, what is left and when it resets. A running sandbox holds 5 minutes at a time ahead. A turn needs at least 30 seconds left to start.

When less than a fifth of the day's time is left, the session and the composer warn you. When it is used up, a turn cannot start, and a running turn is stopped at the end of the time it held. Its sandbox is paused with its files as they are, and the conversation is kept.

### Hosted sandboxes you keep

You can keep 5 of the platform's own sandboxes at once, running or paused. Sandboxes on your own machines are not counted: **On your machines** lists them, with the only limits a machine has, the ones its owner set on its runner (`--max-running`, `--max-sandboxes`, and the snapshot and mirror disk limits). With none set there is no cap; the machine's slots and free disk decide. Nothing is removed to make room by itself. To free one, choose **Free…** beside it, then **Free sandbox**. The dialog says what is lost and what is kept: the workspace's files that are not on GitHub go with the sandbox, while the agent, its conversation and, where the platform keeps one, the copy of the agent's memory stay. The agent's next prompt starts a new sandbox. This cannot be undone.

A hosted sandbox left behind by an agent that no longer exists takes no place, and the platform removes it within 30 minutes. A work item's second reviewer is listed as **Reviewer of “…”**, and shares its item's place.

### Estimated cost

Where the platform's sandboxes are billed by the second, as on E2B, the page shows an estimated cost: the counted seconds times the provider's published price for the sandbox size. It is labelled as an estimate. The provider's bill can differ by a few seconds, and by more when a server stops under a running sandbox.

### Other sections

- **Today by agent**: the day's time, agent by agent.
- **On your machines**: agents on your machines. They are not counted against your daily sandbox time, running agents or kept sandboxes.
- **Work items**: what the Factory may run for you at once, and what each item may spend.
- **The last 14 days**.

## Limits

These are the platform's defaults. Whoever runs the platform can change them.

| Limit | Default |
| --- | --- |
| Model tokens | Unlimited |
| Sandbox time on this platform | 2 hours a day, reset at 00:00 UTC |
| Sandboxes kept on this platform | 5 |
| Agents working at once on this platform | 6 |
| Prompt length | 20,000 characters |
| Turn length | 45 minutes |
| Time to answer a question | 10 minutes |
| Note with an answer | 2,000 characters |
| Clone of a repository | 3 minutes |
| Setup command | 10 minutes |
| Pull request title or commit message | 120 characters |
| Pull request description | 4,000 characters |
| Machines per account | 3 |
| MCP servers per account | 20 |
| Account secrets | 50 |
| Secrets per repository | 50 |
| API tokens | 20 |

A paused sandbox on this platform is removed after 7 days without use. On your own machines, your runner sets sandbox limits. Windlass shares the daily model cap shown on Usage. See [Runner reference](/docs/runner#run-options).
