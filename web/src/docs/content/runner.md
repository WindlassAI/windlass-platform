## How to run a command

The runner is the program in the `windlass-runner` container. Its service starts with the command from the Machines page. To give it options, add them after the runner image in that command:

```sh
docker run -d --name windlass-runner --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner \
  <runner image> --platform <platform address> --max-turns 3
```

To change the options of a running runner, remove the container and run the command again with the new options. The volume keeps the key, so the machine stays paired:

```sh
docker rm -f windlass-runner
```

To run one of its other commands, use `docker exec` on the running container:

```sh
docker exec windlass-runner windlass-runner status
```

## Commands

The runner takes one command. With none, it runs `run`.

| Command | What it does |
| --- | --- |
| `run` | Runs the runner's service. This is the default. |
| `pair` | Makes a new pairing code, for example after the code expired or after the machine was removed. |
| `status` | Says whether the runner is connected, the limits in force, the sandboxes and data volume of each pairing, and whether Claude Code is signed in. |
| `log` | Prints the runner's own record of what it was asked to do, for the last 14 days. |
| `prune` | Removes all containers and data volumes of this runner's pairings. |
| `login claude` | Signs Claude Code in on this machine. The machine must be paired first. |
| `logout claude` | Signs Claude Code out, for this pairing and every earlier one. |

### Status

```sh
docker exec windlass-runner windlass-runner status
```

It prints the runner's version, then its connection, then:

```text
Running turn limit: 2
Running sandbox limit: no limit
Kept sandbox limit: no limit
```

After that it lists each pairing with its sandboxes, its data volume and, where Claude Code is offered, its sign-in.

### Log

```sh
docker exec windlass-runner windlass-runner log
```

### Prune

`prune` asks you to type `yes` first. It refuses while the runner service runs, so stop the runner, prune in a one-off container with the same volume and Docker socket, then start the runner again:

```sh
docker stop windlass-runner
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner <runner image> prune
docker start windlass-runner
```

> **Careful** `prune` removes the agents' files on this machine, and the Claude Code sign-in volume too. It cannot be undone.

## Run options

These options go after the runner image, with the `run` command or with no command.

| Option | Default | What it does |
| --- | --- | --- |
| `--platform URL` | The saved platform | The platform to connect to. It must be HTTPS, or HTTP on loopback. |
| `--max-turns N` | 2 | How many turns run at once. More wait in a queue. |
| `--max-running N` | No limit | How many sandboxes may run at once. |
| `--max-sandboxes N` | No limit | How many sandboxes may be kept on this machine. |
| `--name TEXT` | Docker daemon name or system hostname | Set the machine’s display name for pairing and reports. |
| `--egress MODE` | `restricted` for new pairings, `open` on first upgrade | Choose `restricted`, `open` or `none`. Claude keeps its session-local model relay in all three modes. |
| `--egress-allow HOST[,HOST]` | Empty | With `--egress restricted`, permit exact private DNS names through the proxy. Host interfaces, Docker bridge addresses and metadata stay blocked. |
| `--allow-profile ID` | `docker-hardened` | Which Docker profiles agents may use here. Repeat it for both. |
| `--harness claude` | Off | Offers Claude Code on this machine. Needs a runner built with the Claude Code image. |
| `--screenshots` | Off | Lets work-item sandboxes here take screenshots. Needs a runner built with the screenshots image. |

`N` is a positive whole number. A turn that would pass `--max-running` or `--max-sandboxes` ends with, for example, "This machine has reached its own limit on kept sandboxes, set by --max-sandboxes." The Machines page shows these limits under **Sandbox limit**, and says they are set on the machine, not there.

### Allowed profiles

A new pairing allows only `docker-hardened`. To allow Windlass's own command sandbox as well, start the runner with both:

```sh
--allow-profile docker-hardened --allow-profile docker-windlass-sandbox
```

`docker-hardened` is always allowed, even if you leave it out. The runner saves your choice for this pairing, and uses it again when it restarts with no `--allow-profile`. To withdraw the Windlass profile, start it with `--allow-profile docker-hardened` alone. Its existing workspaces stay on disk.

If an agent asks for a profile the machine does not allow, it is refused: "This machine’s owner has not allowed the Windlass sandbox profile. Start the runner with --allow-profile docker-windlass-sandbox to allow it."

See [The two Docker profiles](/docs/security#the-two-docker-profiles) for what each one protects.

## Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `WLP_RUNNER_CPUS` | Half the CPUs the runner can use, at least 0.5 | The CPU cap of each sandbox. It must be at least 0.01. |
| `WLP_RUNNER_STATE_DIR` | `/var/lib/windlass-runner` | Where the runner keeps its key and state. |

Pass a variable with `-e`, for example `-e WLP_RUNNER_CPUS=2`, before the image in the `docker run` command.

## Messages the runner prints

| Message | What to do |
| --- | --- |
| "The pairing code expired, so restart the container or run `windlass-runner pair` to get a new code." | Restart the container, or run `pair`, and enter the new code. |
| "The platform does not know this machine's key. Run `windlass-runner pair` to add the machine again." | The machine was removed, or its key was lost. Pair it again. |
| "Another runner with this machine's key is connected. If you copied the key, stop the other runner; if you did not, remove the machine on the Machines page." | Stop the other runner, or remove the machine. |
| "This runner is …; the platform needs … or later. Update it with the command on the Machines page." | [Update the runner](/docs/machines#update-the-runner). |
| "Another runner holds the state lock. Waiting to retry." | Two runners share one volume. Stop one. |
| "Docker needs at least 5 GB free to create a sandbox." | Free disk space on the machine. |

After the platform refuses it, a runner tries again in 10 minutes.
