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

- **Docker, hardened**, always.
- **Docker + Windlass sandbox**, only if you allow it when you start the runner, and only where Windlass's sandbox can start in a container there. See [Allowed profiles](/docs/runner#allowed-profiles).

### Turn limit and queueing

A runner runs 2 turns at once by default. More turns wait in a queue, in the order they arrive. A waiting agent says "Waiting for a free slot on your machine (2 of 2 busy)." **Stop** takes a turn out of the queue. To change the limit, start the runner with `--max-turns`. See [Runner reference](/docs/runner#run-options).

### CPU and memory

Each sandbox gets 1536 MiB of memory, at most 512 processes and no Linux capabilities. Its CPU is capped at half the CPUs the runner can use, at least 0.5 CPU. To change the cap, set `WLP_RUNNER_CPUS` in the runner's environment.

## Claude Code on your machine

Claude Code runs only on a machine whose runner was started with `--harness claude`, and only in the **Docker, hardened** profile. The runner must be a build that includes the Claude Code image. If it does not, it says "Use --harness claude with a runner built with the pinned Claude Code image."

To add the flag, put `--harness claude` after the runner image in the command above.

### Sign Claude in

The Machines page shows "Claude Code: not signed in." for such a machine. While the machine is online:

1. Choose **Sign in** beside it.
2. Choose **Open Anthropic to authorize**. Anthropic's page opens in a new tab. The sign-in lasts 10 minutes.
3. Authorize there, then paste the code Anthropic shows into **Paste the code Anthropic shows**, and choose **Finish**.

It can take up to about 20 seconds. Your token is created on your machine, and the runner never sends it to the platform.

> **Careful** Paste the code, never the token. If you paste a token, the page refuses it: "That is a Claude token, not the code."

You can also sign in on the machine itself:

```sh
docker exec -it windlass-runner windlass-runner login claude
```

To sign out:

```sh
docker exec windlass-runner windlass-runner logout claude
```

The token is kept in a Docker volume on your machine and given only to Claude Code's containers, read-only. The platform can run commands in those containers, so those commands could read it there. Use Claude Code with code you trust.

## Machine details and warnings

Each machine on the page shows its state: **Online**, **Offline since** a time, **Waiting for the runner**, or **Needs an update**. Choose **Details** to see whether commands can be sandboxed by Windlass, the free disk, and the sandbox limits set on the machine.

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
