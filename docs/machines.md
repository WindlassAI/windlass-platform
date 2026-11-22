# Machines of your own

How a user's own machine runs sessions: pairing, the runner, the link between them, and what each side can
and cannot do. Users' instructions are in the in-app docs ([Use your own machine](../web/src/docs/content/machines.md),
[Runner reference](../web/src/docs/content/runner.md)); this file is the implementation and the operator's side.

## How it works

With `WLP_MACHINES=1` a user can pair a Linux machine of their own that has Docker, and launch agents on it.
A small program on that machine, the runner, connects out to the platform, and makes and runs the
sessions' containers on the machine's own Docker. Everything else stays with the platform: the session's
actor, the turn's conversation with Windlass, questions, secrets, the GitHub App, the checks' record and the
timeline. Nothing on the machine needs to be reachable from outside. A session's place is chosen at launch
("Where it runs" in the launch form, `place` in `createSession`) and kept for its whole life.

### Pairing

The steps users follow, the runner command, `--name`, the pairing code and updating the runner are in the
in-app docs ([Use your own machine](../web/src/docs/content/machines.md#add-a-machine)). Underneath:

- The runner makes an Ed25519 key pair and keeps the private key in its state volume. It sends the public
  key with its machine's host name, system, architecture and its own version to `POST /runner/pair`, and
  prints the code with the address to enter it at ("Open https://.../machines/add and enter XXXX-XXXX").
- While the user decides, the runner asks `POST /runner/pair/poll`. After **Connect** it prints whose
  account it joined ("Paired with ada. ..."; "an account without a GitHub login" where GitHub is not
  connected) and connects.
- A code belongs to the first account that types it; for any other account it is not found.
- A name given with `--name` is kept in the state volume. A paired runner restarted with a new name updates
  the listing on its next report.
- The Machines page names the image in `WLP_RUNNER_IMAGE` and the address in `WLP_PUBLIC_URL`.

### Profiles allowed on this machine

The `--allow-profile` rules are in the [runner reference](../web/src/docs/content/runner.md#allowed-profiles).
When the owner withdraws the Windlass profile, its existing workspaces stay on disk and can be used again
once the owner restores the flag.

### Network access on this machine

What each `--egress` mode allows is in the in-app docs
([Network access](../web/src/docs/content/machines.md#network-access)). How `restricted` is built:

- Each agent has a loopback-only Docker network. A small helper in that network namespace carries proxy
  traffic over a private Unix socket to an upstream helper.
- Only the upstream helper uses Docker host networking, so that it can identify the host's own interface
  addresses. It listens on the socket, runs unprivileged and has no Docker socket.
- The proxy checks every DNS answer and connects to the address it checked. Host interfaces, Linux bridge
  subnets, loopback, link-local, cloud metadata and CGNAT stay blocked even for `--egress-allow` names.
- The platform's own clone, fetch and push commands use the same proxy.
- Windlass's inner command sandbox has its own loopback and cannot use the proxy.

In `open` mode sessions use a machine bridge with inter-container communication disabled. In `none` mode a
repository session is refused at launch and again when a turn starts. Claude sessions can still send
Messages and token-count requests through their credential relay in every mode. When a kept sandbox was
created under a different mode, the runner stops it and keeps its files; restoring the previous mode
resumes it.

### Launching on it

The launch form lists the user's machines beside the platform's own sandboxes, each
with its state. A machine whose runner has not reported yet cannot be chosen ("“nas” has not connected
yet. Start its runner, and once the Machines page shows it online, start the agent again."), nor one
whose runner is older than the platform takes ("The runner on “nas” is older than this platform takes:
update it to 0.1.0 or later, then start the agent again."). A machine offers the two Docker profiles,
`docker-windlass-sandbox` and `docker-hardened`, as its runner last reported them: the first only where
the owner allows it and bubblewrap starts in a container there.

### Claude Code sessions

When the machine reports Claude Code, `createSession` accepts
`harness: "claude"` with `docker-hardened`. Its runner owns the sign-in. Run
`windlass-runner login claude` on that machine when it needs a login. The platform clones the
repository and runs its setup command before starting the adapter. The first prompt uses the
adapter's default model. Later prompts can select a model and reasoning effort it offered.

The session streams messages, reasoning, tool calls and permission questions over ACP v1. You
can stop a turn and send a follow-up during a turn when the adapter offers steering. The turn
reports context use and cost when available. Its conversation stays in the machine’s sandbox
across turns and sleeps. Removing the sandbox removes that conversation.

Publish from the session panel. The adapter receives no platform tools, saved secrets or user MCP
servers. Individual tool-call cancellation, required checks, token accounting and conversation
backups are unavailable for Claude Code. Work items, reviewers and hosted sessions use Windlass.

### What the platform keeps

The machine's public key, what it said of itself when it was paired, when
its runner was last heard from, and the runner's last report: whether Docker answers, whether bubblewrap
starts in a sandbox there, the free disk space, its sandboxes, and the caps its owner set, where any is
set. The private key never leaves the machine. The runner's request for a connection is signed with it,
its control socket proves it by signing a challenge, and a session's socket carries a ticket the session
made for it, through the machine's control socket, which is good once and for one minute and is signed
with the machine's key too.

### What the runner does

What the server's Docker layer does, on the machine's Docker, and only what its
protocol names: it makes a session's container, runs the platform's commands in it, starts and stops
it, and removes it when asked. It runs the base sandbox image and can optionally run the screenshots image. The base, screenshots and optional Claude Code image pins come from the runner build. It touches only containers it labelled for its own machine
(`dev.windlass-platform.machine=<machine id>`) and keeps Windlass data in
`wlp-machine-<machine id>`, which is Windlass's data directory for the machine's sessions, as the user's
volume is on Docker. Each agent container gets 256 CPU shares and a cap of half the CPUs available to
the runner (at least 0.5 CPU). Set `WLP_RUNNER_CPUS` in the runner's environment to override the cap.
The runner applies that policy when it creates or reconnects a sandbox. Each container gets 1536 MiB
of memory, 512 processes and no capabilities, and creation requires 5 GB of free disk. It stops a
sandbox that has not been used for the idle time the platform names (`WLP_IDLE_SUSPEND_MS`), never while
a command runs in it or the session's socket is connected, and it removes one by itself in one case
only: a container it finds after a restart whose workspace was never set up (no `/workspace/.git`: the
runner stopped between starting it and preparing it) is removed when its session next asks for a
sandbox, and a fresh one is made.

### OpenCode and terminal sign-in

Build the runner with `WLP_RUNNER_HARNESSES="claude opencode" scripts/runner-build.sh`. Run the interactive
setup on the machine, using the runner image you built or its published digest:

```sh
docker run -it --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner \
  <image> setup --platform <url> --harness claude --harness opencode
```

Enter the pairing code on the Machines page and choose **Connect**. Setup asks about each selected agent;
answer **n** to skip its sign-in. For OpenCode, enter a provider ID or search by name. Pick **opencode-go**
for a Go subscription key or **opencode** for a Zen pay-as-you-go key, and paste the key at the hidden
prompt. **chatgpt** starts a separate OpenAI device login, and **free** enables OpenCode's public models.
Public sessions use OpenCode’s anonymous catalog and carry their own ACP client identity. If the
provider returns HTTP 429, the turn reports that its usage or rate limit was reached. A working
interactive terminal session can coexist with a refused anonymous ACP request on the same machine.

To import existing API keys, add
`--mount "type=bind,src=$HOME/.local/share/opencode,dst=/import/opencode,readonly"` before the image name
(use your `XDG_DATA_HOME` path if you set one). A bind mount fails when the folder is missing instead of
creating it as root. The Machines page offers this mount. Setup reads `auth.json` once and asks about each
provider; entries with OAuth or refresh tokens are never imported, and a subscription gets a separate
runner-owned login instead. If nothing was imported, setup goes on to the normal sign-in. The final
command starts the background runner with only the Docker socket and runner state mounted.

Add a provider or renew a key with `docker exec -it windlass-runner windlass-runner login opencode`
(append `--provider opencode-go` to pick Go directly), and clear the machine's OpenCode logins with
`logout opencode`. ChatGPT and the OpenAI API key share the native `openai` slot; public access and a Zen
key share the `opencode` slot; signing into a slot replaces its previous method. Go has its own slot.

OpenCode runs in personal hardened Docker sessions. The machine's relay holds the credentials, refreshes
ChatGPT tokens and checks each session's signed placeholder; agent commands can use the quota of the
configured providers. Adding a provider or changing a key keeps existing sessions working, because the
relay looks up the current key on each request. A full `logout opencode` or a new pairing invalidates the
placeholders, and affected sessions must be recreated. Open and restricted sessions both send inference
through the loopback relay. See [the relay's provider routes](../sandbox/relay/README.md#opencode-1196).

The credential relay checks decoded JSON strings in successful responses. For Anthropic Messages
streams it joins text deltas by content-block index and holds a possible credential prefix across
events. Other provider event formats are checked one JSON event at a time. A credential divided
between those events or encoded as model output in another representation can pass this check.
The relay closes the response on malformed JSON or an oversized JSON document or SSE event.

Machines report each agent's models, efforts and modes at startup, after each login or logout, and every
six hours. The composer fetches a catalog by digest only when it changes; host load and memory travel
separately.

### Claude Code on this machine

Build the runner with `WLP_RUNNER_HARNESSES=claude scripts/runner-build.sh`
and add `--harness claude` after the runner image in the pairing command. Only the hardened Docker
profile offers Claude Code. To sign in, run `docker exec -it windlass-runner windlass-runner login claude`.
Anthropic's `claude setup-token` opens its browser sign-in flow and prints a token in your attached
terminal. Paste it at the hidden prompt. A token minted on another computer works there too.

The runner stores the token in `wlp-harness-claude-<machine id>`. The local login helper writes it.
A per-machine relay reads this volume for each request. Each hardened Claude session gets a
signed placeholder bound to its own loopback helper. Commands in the session
can use the login and consume quota while it runs. The setup token stays in the relay.
The relay sends Messages and token-count requests to `https://api.anthropic.com`.
Conversations stay in their individual containers.

In every egress mode Claude uses `http://127.0.0.1:17892`. A trusted helper in the
session’s network namespace forwards this port over a Unix socket to the relay. Each
connection carries the helper’s session identity. The relay checks it against the signed
placeholder before reading the token. The relay uses its own outbound HTTPS route to
Anthropic. The agent keeps its original interfaces and mounts.
[Relay verification and Docker checks](../sandbox/relay/README.md)

`docker exec windlass-runner windlass-runner status` shows the local sign-in state.
`docker exec windlass-runner windlass-runner logout claude` removes the relay and token for each
pairing. The runner's `prune` also removes the socket and login volumes.

Update the server first. Stop the previous runner and its Claude sessions, archive any needed
workspaces locally, then install the runner with its pinned Claude image. The runner stops legacy
sessions with credential mounts and refuses to reopen them. Recreate those sessions, revoke
the previously exposed setup token, and sign in with a fresh one. Restore archived work selectively.
Before rolling back to a runner that mounts credentials, log out and disable its Claude harness.

### What the runner cannot do, and what the platform cannot do

The runner cannot start a container of
another image, run anything on the machine outside the containers it made, touch a container or a volume
it did not make, or reach a session that did not hand it a ticket. Each Windlass turn is
handed a ChatGPT access token in a file, as on every place. The platform, for its part, cannot reach the
machine except through its runner, and does not control it: whoever runs the machine can change what
runs there and what it reports. The launch form, the profiles and a pull request's section say so.

### No limit unless its owner sets one

The platform counts nothing of a machine: its sandboxes take no
sandbox time and no place among the kept sandboxes, have no price, and its turns are not among the
user's agents working at once: one rule, `hostedLimitsApply` (`server/src/usage.ts`), holds a session
to the daily time, the kept sandboxes and the running agents, and it holds only a hosted one.
A runner accepts two simultaneous turns by default. Set `--max-turns N` to change this.
The machine actor queues additional turns in arrival order and keeps them across runner reconnects.
Stop cancels a queued turn. Older runners omit the turn limit and allow unlimited concurrent turns.
For optional limits on Docker containers, its runner takes `--max-running` and `--max-sandboxes`, with no
default, after the command above, and a turn that would pass one ends with "This machine has reached its
own limit on kept sandboxes, set by --max-sandboxes." (or on running sandboxes, by `--max-running`). The
Machines page shows what is in force under "Sandbox limit", "no limit" or the numbers, and says that a
limit is set on the machine, not there.
A sandbox there is not removed after `WLP_IDLE_DESTROY_MS` either: it goes with its agent, with the
machine's sandboxes, or by `prune`.

### When the link drops

One control socket per machine to its `machine` actor, and one socket per
session to that session's actor while the session needs its machine, both through the engine's gateway.
A dropped socket does not end a turn: both ends keep what the other has not acknowledged, and the turn
goes on when the runner is back, with every event once. A socket that goes silent without closing, as
when the machine sleeps or loses its network, counts as dropped after 45 seconds (`DEAD_MS`). While a
turn's work waits on a dropped socket, the session asks the runner back and says "Your machine "nas" is
not answering since 14:02. The turn goes on when it is back, or stops at 14:12." The banner follows the
machine while the page is open: the session pushes a `machine` event to it each time what it found
changes (answering, not answering, offline, removed). Ten minutes without the runner (`RUNNER_GRACE_MS`)
end that conversation, and what was outstanding in it fails. A control socket silent for 90 seconds
(`CONTROL_DEAD_MS`) is closed, and the machine is shown offline. An operation that is the same done twice
is asked once more after a lost conversation, `create` included: the runner answers a second `create`
for a session with the sandbox that session already has, so a lost answer never makes a second sandbox.
A message sent into the running turn while the machine is not answering is refused at once ("Your
machine is not answering, so the message was not sent. Send it again when it is back.",
`turn_running`), and so is stopping one tool call ("Stop the turn instead, or try again when the
machine is back."); stopping the whole turn works, since it waits for nothing on the machine.

### When the runner cannot reach the platform

It tries again at once, then after 1 s, 2 s, 4 s and so
on up to 15 s between attempts, each attempt given 5 s, and back to 1 s once connected; so a runner is
online again within seconds of its network being back. A control socket that sends no hello within 10
seconds of opening is closed as gone away (1001), not as refused, and the runner tries again in the same
way: a link that stalls right after a wake costs no turn. What the platform refuses is different: a
removed key (410), a key it does not know (403), a socket closed as a refusal (1008, or a code from 4000
to 4999), or another 4xx when it first asks `POST /runner/connection` (a renewal of its credential that
fails keeps the connection it has, and is tried again with the next session that attaches). Then the
runner ends its sessions' conversations, so every turn running on the machine ends, says why and when
it will try again in `windlass-runner status`, and waits ten minutes (`REFUSED_RETRY_MS`) before it
asks again; a removed key it does not ask again with at all. A removal it cannot carry out (Docker not
answering) it leaves unacknowledged, and the platform asks again when the runner next connects. A second runner started on the same state volume waits for the
first one's lock ("Another runner holds the state lock. Waiting to retry.") and looks again every ten
minutes, instead of exiting into Docker's restart loop; a second runner with a copy of the key on
another volume is refused at once, and the Machines page warns of it.

### When the runner restarts

Its conversations with the sessions are in its process's memory, so a turn
running then ends, not as done; the next turn stops what the old one left running in the sandbox, and
runs.

### When a server restarts

The session goes to sleep as any does ([When a server stops](architecture.md#when-a-server-stops)) and its
conversation with the runner ends with it; the next turn, on whichever server, opens a new one. The
session does not suspend a machine's sandbox on its way to sleep (`[wlp] sandbox.suspend_skipped`): the
runner stops it after the idle time.

### When the machine is offline

An agent can be launched on it, and the form says that a prompt sent
before the machine is back fails. A prompt is not queued: it fails with "Your machine "nas" is offline.
The agent's files are there; send the prompt again when it is back.", at once when the machine's actor
knows it is offline, and after 15 seconds when the runner does not answer. The banner above the
composer says since when the machine is offline.

### When the machine is removed

"Remove…" on the Machines page deletes its key: the runner's control
socket is refused at once, and the runner forgets its key, stops its sandboxes and waits to be paired
again ("This machine was removed from its account, so run `windlass-runner pair` to pair it again with a
new key."). With "Also remove the agents' sandboxes on it", it removes them and its data volume instead,
at once when it is connected and when it next connects when not. A turn running on the machine ends
within seconds: the timeline closes it with the sentence of an engine that stopped in the middle of the
turn, not with the removal; from then on the banner says "This agent's machine was removed. Its files
were there. Start a new agent to go on.", a prompt is answered with the same sentence, and the agents
keep their timelines. If the machine's control connection was already down when it was removed, its
runner learns of the removal only when it next connects, within about twenty seconds of its network being back, and
serves the sessions it already has until then. Deleting an agent on a machine records the removal of its sandbox with the
machine's actor, and the runner removes it, at once when it is connected and when it next connects when
not. A delete whose removal could not be recorded is refused (`machine_unreachable`: "The agent could
not be deleted: its machine's record of the sandbox to remove could not be written. Try again in a
moment."), and the agent stays listed until a delete goes through; once the removal is recorded, nothing
the runner answers holds the delete back.

### Not seen for 90 days

A machine whose runner has not been heard from for 90 days is removed with its
key (`MACHINE_EXPIRY_MS`); its agents keep their timelines, and its sandboxes are left where they are.

### Forgetting the ChatGPT sign-in

Each machine whose runner is connected at that moment is told, and
its runner removes the token files of running turns from its data volume. A machine that is offline then
is not told, and is not told later: the platform keeps no logout for it. A token in a file there, which a
turn cut off by the machine going away can leave, lasts about an hour from when it was handed out, and
whoever reads it cannot renew it. To remove such files sooner, the machine's owner removes the runner's
sandboxes and its data volume there with `prune`. It refuses to run while the runner does ("The runner
service or another command is using this state volume. Stop the runner container or finish the command,
then run prune in a one-off runner container with the same state volume and Docker socket."), so the
runner is stopped first, and started again afterwards:

```sh
docker stop windlass-runner
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner <WLP_RUNNER_IMAGE> prune
docker start windlass-runner
```

### Pull requests, and the machine's name

The session keeps its machine's name from the launch, so it
can name the machine while the machine is offline. A pull request of a session on a machine keeps its
"What was verified" section, with one more line: "These checks ran on ada's own machine, “nas”; this is
what that machine reported." And the question about a project's MCP server says where the server would
run: "It runs in this session's container on your machine "nas", with its network, ..."

### The pairing limits

A user can have three machines paired at once (`MAX_MACHINES`): each machine
that is connected keeps an actor awake on the platform, and this is what bounds that cost for one
account. A user can look up five codes in ten minutes. And the platform's routes see no client address
they could trust, so the pairings that are started are limited by the machine key that starts them,
three in ten minutes, and in 64 groups of sixteen that a key cannot choose. That bounds how many pairing
attempts anyone can leave open on the deployment; someone who makes many keys can use up the starts for
ten minutes, and the runners that are paired already are not affected.

### What the runner reports on the machine

`windlass-runner status` (in the container:
`docker exec windlass-runner windlass-runner status`) says whether it is connected, the caps in force and
the sandboxes and data volume of its pairings; `windlass-runner log` is its own record of what it was
asked.

## Turning machines on

| Variable | Effect |
|---|---|
| `WLP_MACHINES` | `1`: every user of the deployment may pair machines. Off (the default): the runner's routes answer 404, the machine actions refuse with `machines_off`, and platform info has no `machines`. The machines and their tables stay, so turning it off and on again loses nothing |
| `WLP_PUBLIC_URL` | the platform's address as a machine outside reaches it: an `https://` origin, or `http://` on a loopback address, with no path. Required with `WLP_MACHINES=1` and a remote engine; with the local one, `http://localhost:<WLP_HTTP_PORT>` |
| `WLP_RUNNER_IMAGE` | the runner image the Machines page tells users to start, pinned by digest (`<name>@sha256:<64 hex>`). Unset: the page says that it cannot be installed yet. Set to anything else, the server does not start |

## Building the runner

This repository publishes no runner image, so a deployment builds its own:
`scripts/runner-build.sh [<sandbox image pin>]` builds a local runner and prints its image ID.
It pins the sandbox image by ID, using `windlass-platform-sandbox:latest` by default.
With `WLP_RUNNER_PLATFORMS=linux/amd64,linux/arm64` it writes a two-architecture OCI archive
and prints its path. Set `WLP_RUNNER_ARCHIVE` to choose the archive path.
A new sandbox image means a new runner build. Until `WLP_RUNNER_IMAGE` is set, the Machines page says that the
runner is not published and shows no command; a runner built on the machine itself is started with the same
command, naming the local image:

```sh
docker run -d --name windlass-runner --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner \
  <runner-image-id> --platform <WLP_PUBLIC_URL>
```

Pair using the code it prints. To offer screenshots on this machine, build the second runner and start
the same Docker command with `<screenshots-runner-image-id> --screenshots --platform <WLP_PUBLIC_URL>`.
From `server/`, after building both sandbox variants, build the two runners with:

```sh
../scripts/runner-build.sh
../scripts/runner-build.sh --screenshots
```

The second build pins both local image IDs. For a release, pass the base digest as the first
argument after `--screenshots` and the screenshots digest as the second. An unflagged runner
uses the base image even when a repository enables screenshots. Its builder can file a text report.

Give it a sandbox image pinned by id, so that a rebuild of
`windlass-platform-sandbox:latest` does not change what an existing runner runs. `docker-windlass-sandbox` is offered on a machine only where the
owner allows it and the runner’s bubblewrap probe passes. Work items can use either available profile ([work-items.md](work-items.md#where-an-item-runs)).

