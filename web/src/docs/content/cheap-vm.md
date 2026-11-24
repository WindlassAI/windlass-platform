If you have no spare computer, a small cloud VM can be [one of your machines](/docs/machines). Turns there use none of your hosted sandbox time. You pay for the VM and can use your own model plans, such as a Claude subscription for Claude Code or your own provider for OpenCode.

## Choose a VM

Pick a Linux VPS that can run Docker, e.g. a shared-vCPU VM on [Hetzner Cloud](https://www.hetzner.com/cloud/) or an [Oracle Cloud Always Free Ampere VM](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) if one is available in your home region. Choose a region near the platform or near you. The released runner and agent images support both x86-64 and 64-bit ARM, including Ampere and Graviton.

| Agents working at once | Suggested VM | What to choose at setup |
| --- | --- | --- |
| One | 2 vCPU, 4–8 GB RAM | Keep the default of one turn slot. |
| Two | 4 vCPU, 8–16 GB RAM | Choose two turn slots under **Limits**. Use the higher end for larger builds. |

A personal turn uses one slot. By default the runner counts how many slots of 2 CPUs and at least 4 GiB fit after it reserves CPU and memory for the host. It shares the remaining memory among those slots, up to 8 GiB each. On a 4-vCPU VM the CPU reserve leaves room for one automatic slot. If even one full slot cannot fit, the runner makes one slot that shares all the cores and uses up to 4 GiB, leaving at least 1 GiB or a quarter of RAM for the host, whichever is larger.

Docker images and workspaces need about 20–30 GB. By default `--keep-free` keeps 40 GB free, so to keep setup snapshots and Git mirrors choose about 80 GB of disk, or give a smaller disk a lower `--keep-free`, such as `--keep-free 10GB`. Below that threshold the runner evicts the oldest snapshots first and saves no new snapshots or mirrors. `--snapshot-disk` caps all setup snapshots (10 GB by default) and `--snapshot-user` caps one user's share (2 GB). You can lower the free-space target as far as the platform allows. See [Run options](/docs/runner#run-options).

## Set up the VM

1. Create a fresh Ubuntu or Debian VM with your SSH public key. Check that you can sign in with the key, then turn off SSH password login. In the cloud firewall, deny inbound connections except SSH from your address if you use it. The runner connects out to the platform and needs no inbound port.
2. Enable automatic security updates with `unattended-upgrades`.
3. Install Docker Engine using Docker's instructions for [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) or [Debian](https://docs.docker.com/engine/install/debian/). Check that `docker info` works as the user who will run setup and that Docker starts at boot.

## Pair the runner and start an agent

In the account menu, open **Machines → Add a machine**. Copy the line below from the dialog so it has your platform's address, then run it in your SSH terminal on the VM.

```sh
curl -fsSL <platform address>/install.sh | sh
```

1. When setup shows a pairing code, choose **Enter the code** in the browser, enter it and choose **Check code**. Compare the machine key on the page with the one in your terminal. If they match, tick the confirmation and choose **Connect**.
2. Give the VM a name you will recognize. Pick your agents and sign them in with your accounts.
3. At **Network**, keep **Restricted** (`--egress restricted`), the default for a new pairing. Commands can reach public sites through the runner's proxy. The VM itself, private networks and cloud metadata addresses are blocked by default. Choose **Only some public hosts** to narrow public access. **Open** allows local network access too. See [Network access](/docs/machines#network-access).
4. Review **Limits** and start the runner. Setup waits for **Online**. When you start an agent, choose the VM under **on**.

You can close SSH. Setup starts the `windlass-runner` container with `--restart unless-stopped`, so Docker brings it back after a reboot unless you stopped it yourself. Keep the `windlass-runner` volume. It holds the machine's pairing key.

## Update the runner

When **Machines** shows **Needs an update**, run the same one-line install again on the VM. Setup fetches the new runner and offers to replace the container. Keep your saved answers and pairing. If the page asks you to pair again, follow [Update the runner](/docs/machines#update-the-runner).

## Troubleshooting

- **A slot ran out of memory.** The turn's timeline shows the slot limit when the kernel kills a command. Check **Machines → Details → Capacity**. Configure fewer slots so each can use more memory, or raise `--slot-memory` within the VM's memory budget. See [CPU and memory](/docs/machines#cpu-and-memory).
- **The disk is full.** Check **Free disk** under **Details**. Docker needs at least 5 GB free to create a sandbox. Free space on the VM or grow the disk. If only snapshots and mirrors have stopped saving, check the effective **Snapshot storage** limits.
- **The runner is offline.** Check that the VM and Docker are running. If the container is stopped, run `docker start windlass-runner`. Read `docker logs windlass-runner` for connection errors and check that the VM can reach the platform. Once **Machines** shows **Online**, try again.
