## Why use your own machine

An agent on one of your machines runs in a Docker container there, made by a small program called the runner. Its sandboxes take none of your daily sandbox time, no place among your kept sandboxes and no place among your agents working at once. You set its limits yourself. On a machine you can also run Claude Code with your Claude subscription.

The runner connects out to the platform. Nothing needs to reach your machine from outside.

## What you need

- A Linux machine with Docker.
- At least 5 GB of free disk for each new sandbox.
- A clock set from the network. The platform warns you when the machine's clock is more than a minute off.

An account can connect up to 3 machines.

## Add a machine

Open the account menu and choose **Machines**, then **Add a machine**.

### 1. Start the runner

The dialog shows a command. Copy it and run it on your machine. It has this shape; the image and the address come from the platform:

```sh
docker run -d --name windlass-runner --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner \
  <runner image> --platform <platform address>
```

The runner keeps its key and its state in the `windlass-runner` volume. Keep that volume: it is what keeps the machine paired.

> **Tip** Where rootless Docker works, use it: the runner then gets less of your machine. Mount `$XDG_RUNTIME_DIR/docker.sock` in place of `/var/run/docker.sock`.

### 2. Enter the code

When it starts, the runner prints a pairing code like `XXXX-XXXX`, and the address to enter it at:

```sh
docker logs windlass-runner
```

Choose **Enter the code**, type the code and choose **Check code**. Case, spaces and dashes do not matter. A code lasts ten minutes. It belongs to the first account that enters it.

### 3. Connect it

The page shows what the machine says about itself: its name, OS, architecture and runner version. Nobody has checked these. Connect it only if it is the machine you started the runner on. Then choose **Connect**.

The runner then prints whose account it joined: `Paired with <your GitHub login>`. If that is not you, run `windlass-runner pair` again.

### Name it

The machine is named after its Docker daemon, or its hostname if Docker gives none. To choose the name yourself, add `--name` after the runner image, with `run` or `pair`:

```sh
<runner image> --platform <platform address> --name "Build box"
```

A name has 1 to 64 printable characters. The runner saves it and uses it again when it restarts without `--name`.

> **Note** If the code expired, the runner says so. Restart the container, or run `windlass-runner pair`, to get a new code.

## What the machine receives

A machine runs the agents you start on it. It receives what they need, and nothing once it is removed:

- your repository's files;
- the saved secrets each agent is allowed, while **Send saved secrets to this machine** is on;
- a ChatGPT access token for each turn of a Windlass agent, which lasts about an hour.

The platform does not control this machine. What a session there shows of checks and changes is what the machine reports. See [Sandboxes and security](/docs/security#on-your-machine) for what the platform can and cannot do there.

### Saved secrets

Each machine has the switch **Send saved secrets to this machine**. It is on for a new machine. When it is on, each turn of an agent there gets the saved secrets it is allowed, the repository's and the account's. Turned off, none are sent, and whatever needs one fails on this machine. A change holds from each agent's next turn.

## Run agents on it

When you start an agent, choose the machine under **on**. Each machine offers two Docker profiles:

- **Hardened Docker on your machine "…"**, always.
- **Docker + Windlass sandbox on your machine "…"**, only if you allow it when you start the runner, and only where Windlass's sandbox can start in a container there. See [Allowed profiles](/docs/runner#allowed-profiles).

### Turn limit and queueing

The runner sizes its slots from the machine’s CPU and memory. A personal turn takes one slot by default. A large factory turn can take up to four. Turns wait in arrival order, so a large turn at the head waits for enough free slots before a smaller turn can start. **Stop** takes a turn out of the queue. Set the capacity with `--slots` or `--max-turns`. See [Runner reference](/docs/runner#run-options).

### CPU and memory

On a machine with one or two CPUs, one slot defaults to half the available CPUs, 1536 MiB of memory and 512 processes. Larger machines reserve CPU and memory for the host before dividing resources into slots. **Details → Capacity** shows the slot count and the CPU and memory per slot. Use `--slot-cpus`, `--slot-memory` and `--sandbox-memory` to set the CPU per slot, memory per slot and total sandbox memory budget.

## Network access

Each machine has one network mode for its agents' commands. You choose it when you start the runner, with `--egress`:

| Mode | What commands can reach |
| --- | --- |
| `restricted` | Public sites, through a web proxy the runner keeps beside each sandbox. Not your local network, the machine itself, Docker's networks or cloud metadata addresses. This is the default for a new pairing. |
| `open` | The internet and your local network, directly. Agents on the machine still cannot reach each other. |
| `none` | No network at all. An agent here cannot have a repository. |

The runner saves the mode for this pairing, and uses it again when it restarts without `--egress`. It prints the mode when it starts, and `status` prints it too, for example "Network egress is restricted."

### Restricted

In `restricted` mode the sandbox has no network of its own. The runner sets `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` in it, and a web proxy on the machine connects for it:

- Programs that use those settings get out, to any port. Programs that ignore them have no network.
- The runner resolves names itself, on the machine, and checks the address before it connects.
- Your private network (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and `fc00::/7`) is refused, unless you allow a name with `--egress-allow`.
- The machine's own addresses, every Docker network on it, `169.254.0.0/16` and other special ranges are always refused.

A refused request gets `403 Forbidden`. For a plain `http:` request, the answer also says "blocked by runner egress policy".

To let commands reach a host on your private network, name it:

```sh
<runner image> --platform <platform address> --egress restricted --egress-allow git.internal.example,registry.internal.example
```

Give exact DNS names, up to 64, separated by commas. IP addresses are refused. A listed name is still refused if it resolves to the machine itself, a Docker network or a metadata address. `--egress-allow` alone means `restricted`. `--egress restricted` without `--egress-allow` empties the list.

### None

In `none` mode commands have no network. A repository cannot be cloned there, so an agent on a repository is refused: "This machine uses --egress none. Start the session without a repository or restart the runner with --egress restricted." Start it with **No repository**, or change the mode.

### Pairings made before network modes

A machine paired before network modes existed stays `open` until you give `--egress`. Its runner says so when it starts: "Network egress is open for this existing pairing. Start the runner with --egress restricted to opt in."

### Changing the mode

The new mode applies to sandboxes the runner makes from then on. A kept sandbox made under another mode is paused, and using it again is refused: "This kept sandbox has a different network policy. Save its workspace and recreate the sandbox to use the runner’s current --egress setting." Take what you need from it, delete the agent and start a new one.

### What the session shows

When you choose **Hardened Docker on your machine "…"**, the **sandbox** chip and the session's **Sandbox** panel say what its commands can reach:

| Mode | The network fact |
| --- | --- |
| `restricted` | "commands can reach public sites and hosts allowed by the owner through the web proxy" |
| `open` | "commands can reach the internet and the local network" |
| `none` | "commands have no network" |

In **Docker + Windlass sandbox on your machine "…"**, commands have no network whatever the mode. A repository's setup command uses the machine's mode in both profiles.

## Say when to use it

You can tell the planner of an orchestrated work item what each machine is for. On the Machines page, choose **Add** beside "No note on when to use it.", or **Edit** once there is one. Fill in:

- **When to use it**: a note of up to 500 characters, for example "Builds and browser tests; it has the GPU".
- **Tags**: up to 12, with a comma or a space between them, for example `gpu, big-build`. A tag has letters, digits, `-` and `_`, starts with a letter or digit, and is up to 24 characters long. `os`, `arch` and `screenshots` come from the runner, so you cannot set them.

Choose **Save**. The planner reads this, with the machine's OS, capacity and what it can run, when it splits a feature into subtasks. Nothing else reads it. See [Orchestrate](/docs/factory#orchestrate-a-feature).

### Let features use it

Under **Details**, **Subtasks of features** says whether a feature's subtasks may run on the machine:

- **Any feature** (the default): features may place subtasks here.
- **When named**: only when a plan names this machine for the subtask.
- **Never**: features never place subtasks here.

The choice is saved at once. A machine that is not on **Any feature** says so on its card, for example "features: when named". A subtask that only inherits the feature's place counts as not named, so a feature filed on a **When named** machine must name it in each subtask. A plan that needs a **Never** machine cannot be approved: the plan says why under the subtask. See [Placement](/docs/factory#placement).

## Claude Code on your machine

Claude Code runs only on a machine whose runner was started with `--harness claude`, and only in the hardened profile, **Hardened Docker on your machine "…"**. The runner must be a build that includes the Claude Code image. If it does not, it says "Use --harness claude with a runner built with the pinned Claude Code image."

To add the flag, put `--harness claude` after the runner image in the command above.

### Sign Claude in

The Machines page shows the sign-in state and a command to copy. Run it in a terminal on the paired machine.

```sh
docker exec -it windlass-runner windlass-runner login claude
```

To sign out:

```sh
docker exec windlass-runner windlass-runner logout claude
```

### Your Claude login stays out of the container

The runner stores the setup token in a login volume on your machine. No session container mounts it. A separate relay container on the machine holds it instead, and is the only one that reads it.

Each Claude session gets the relay's address and a placeholder in place of the token. The placeholder is signed by the machine's key and is good only for that session. The relay checks it on every request, then sends the request on to Anthropic with the real token. It takes only Claude's model requests. Anything else is refused: "Claude credential relay refused the request."

So commands in a Claude session cannot read your token. They can still use that session's relay and consume subscription quota, in every network mode, `none` included.

Older runners mounted the login volume in Claude sessions. On upgrade, archive any work you need from those stopped sessions, remove them, revoke the old token with Anthropic, and sign in with a fresh token before recreating the sessions.

## Machine details and warnings

Each machine on the page shows its state: **Online**, **Offline since** a time, **Waiting for the runner**, or **Needs an update**. Choose **Details** to see:

- **Sandboxes**: the agents' sandboxes on it;
- **Commands sandboxed by Windlass**: whether Windlass's own sandbox can start there, and why not;
- **Capacity**: the turns running and queued, the CPUs given to sandboxes and the memory free;
- **Free disk**;
- **Sandbox limit**: the limits set on the machine with `--max-running` and `--max-sandboxes`;
- the switch **Send saved secrets to this machine**.

The page also warns you when:

- the runner cannot reach Docker on the machine;
- the machine's clock is too far off. Set the clock from the network, for example with `timedatectl set-ntp true`;
- the machine's key was used from two places. If you did not copy it, remove the machine.

## Update the runner

When the platform needs a newer runner, the machine shows **Needs an update**. Remove the container and run the same command again:

```sh
docker rm -f windlass-runner
```

Then run the command from the Machines page. The volume keeps the key, so the machine stays paired.

## Remove a machine

Choose **Remove…** on the machine, then **Remove machine**. Its key stops working at once.

- An agent on it keeps its conversation, but cannot run again.
- Its files stay on the machine, unless you also tick **Also remove the agents' sandboxes on it**. The runner then removes them now, or when it is next online.

To add the machine again later, run `windlass-runner pair` on it.

A machine that the platform has not heard from for 90 days is removed by itself. Its sandboxes are left in place.
