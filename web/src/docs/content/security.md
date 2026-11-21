## The rule that holds everywhere

Your ChatGPT sign-in is never in a sandbox. The platform keeps it. For each turn of a Windlass agent, it hands the sandbox a short-lived access token in a file instead. That token lasts about an hour and cannot be renewed. It is replaced during the turn and removed when the turn ends.

Whether the agent's commands can read that token depends on the sandbox. Each sandbox says so when you choose it.

## Where sandboxes run

- **On this platform.** The platform makes and controls the sandbox. A platform runs its sandboxes on one provider: Docker, or E2B microVMs. The **sandbox** chip lists the ones it offers, with the layers that isolate each.
- **On one of your machines.** The runner makes a Docker container there. The platform does not control the machine. See [On your machine](#on-your-machine).

## What every Docker sandbox gets

Every Docker sandbox, on the platform or on a machine, is a container with:

- a non-root user, `agent`;
- no Linux capabilities, and no way to gain privileges (`no-new-privileges`);
- 1536 MiB of memory, with no extra swap;
- at most 512 processes;
- a CPU cap and a small CPU share;
- network access according to the platform or machine policy.

On a machine, the runner uses only the images pinned in its own build. The platform cannot name another image.

## The two Docker profiles

### Docker + Windlass sandbox

`docker-windlass-sandbox`. A container of its own, and every command the agent runs is sandboxed again by Windlass:

- commands have no network;
- they can write only in the workspace and in a home of the session's own;
- credentials are hidden from them, so the session's access token is out of their reach.

So that Windlass's bubblewrap sandbox can work inside it, the container runs under a seccomp filter that is Docker's default plus the namespace and mount calls bubblewrap needs, without Docker's AppArmor profile, and with the system paths unmasked. The isolation of each command then comes from Windlass's sandbox. Its Windlass modes are **Ask** and **Auto**.

### Docker, hardened

`docker-hardened`. A container under Docker's default seccomp and AppArmor profiles. Commands run directly in it with the container’s network policy. In a Windlass session they can read the turn’s access token. Its Windlass modes are **Ask** and **Full**. Claude Code runs only in this profile.

| | Docker + Windlass sandbox | Docker, hardened |
| --- | --- | --- |
| Commands sandboxed again | Yes, by Windlass | No |
| Network for commands | No | Follows the container’s network policy |
| Commands can read the access token | No | Yes |
| Your ChatGPT sign-in in the container | Never | Never |
| Windlass modes | Ask, Auto | Ask, Full |
| Claude Code | No | Yes |

> **Note** A repository’s setup command uses the container’s network policy in both profiles.

## E2B sandboxes

On a platform that runs on E2B, each sandbox is a microVM of its own, hosted by E2B, where commands run as a non-root user. Which E2B sandboxes are offered depends on the platform, and each one's description says what it promises:

- **E2B + Windlass sandbox**: every command is sandboxed again by Windlass, with no network and the access token out of reach.
- **E2B**: nothing is promised inside the microVM. A command may have network and may read the access token. Windlass asks before any command it cannot sandbox.
- **E2B, microVM only**: no sandbox inside the microVM. Commands run without asking, can reach any host and can read the access token.

## On your machine

A machine offers the same two Docker profiles: **Hardened Docker on your machine** always, and **Docker + Windlass sandbox on your machine** only if you allow it with `--allow-profile docker-windlass-sandbox`.

Its network mode, set with `--egress`, decides what commands in the hardened profile can reach:

- `restricted`, the default for a new pairing: public sites through the runner's web proxy. Your private network, the machine itself, Docker's networks and metadata addresses are refused, except private hosts you name with `--egress-allow`.
- `open`: the internet and your local network, directly. Agents cannot reach each other.
- `none`: no network, and no repository.

See [Network access](/docs/machines#network-access) for the details.

### Agent logins stay on the machine

An agent's login is never inside its container. Claude Code's setup token lives in a login volume that no session mounts. A relay container on the machine reads it, and forwards each session's model requests to Anthropic with it. The session gets only a placeholder, signed for that one session, and the relay's address. Claude sessions keep their relay in every network mode. See [Your Claude login stays out of the container](/docs/machines#your-claude-login-stays-out-of-the-container).

### What the platform can do there

The platform can ask the runner only for what its protocol names. In short, it can:

- create a sandbox, giving only the profile, the agent and whether it takes screenshots;
- connect to a sandbox, read its state, pause it and remove it;
- run commands in a sandbox, and start, signal and stop its processes;
- read and write text files in a sandbox, and write secret files there.

> **Careful** The platform can run any command in the containers the runner made, Claude Code's containers included. In a Claude Code container, commands can use the session’s model relay and consume your quota. Older runners with the login volume mounted in the session also expose the setup token.

### What the platform cannot do there

The runner cannot start a container of another image. It cannot run anything on the machine outside the containers it made. It cannot touch a container or a volume it did not make. It cannot reach a session that did not hand it a ticket.

The platform cannot reach your machine except through its runner. It does not control the machine: whoever runs the machine can change what runs there and what it reports. That is why a session on a machine says that its checks and changes are what the machine reports.

### How the runner proves who it is

The runner makes an Ed25519 key pair when it pairs. The private key stays on the machine. Every connection is signed with it. A session's connection also needs a ticket that is good once and for one minute. If the machine's clock is more than a minute off, the platform tells the runner, and the Machines page warns you.

## Secrets

You can save secrets for a repository and for your account. A secret's value goes to the platform once and is never shown again. Values are stored encrypted.

A secret reaches the sandbox as an environment variable, never on a command line. Who gets it depends on what you choose for it:

| Secret | Default | With **Also the agent's commands** |
| --- | --- | --- |
| Repository secret | The setup command, and the MCP servers the repository names that read it as `${NAME}` | The agent's commands too |
| Account secret | MCP servers only: your own, and a repository's once you approve it | The agent's commands too |

- A repository's setup command never gets an account secret.
- Where a repository has a secret of the same name as an account secret, its agents get the repository's.
- In a sandbox that does not sandbox the agent's commands, such as **Docker, hardened**, secrets meant only for MCP servers are not passed at all. A server that needs one does not start there.
- On your machine, secrets go only while **Send saved secrets to this machine** is on.
- Claude Code sessions get no saved secrets.

> **Careful** Whatever the agent's commands can read, a manipulated agent could send out once a command has network access. Give a secret to the agent's commands only when it needs it.

### Values are taken out of what you see

The platform takes every saved value out of what it shows and keeps of an agent's work: the timeline, the output of commands and error messages. It shows `[secret:NAME]` instead. A value that a program changes before printing it, into base64 say, is not recognised.

Before a push, the platform also looks for saved values in the changes. If it finds one, nothing is pushed.

## GitHub access

The agent's sandbox is never given your GitHub access. For a clone or a push, the platform makes a token for that one repository that lasts an hour at most, hands it to that one git command, and revokes it when the command ends. See [What the GitHub App may do](/docs/getting-started#what-the-github-app-may-do).
