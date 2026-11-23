# Configuration

Every setting the server, the web app and the build scripts read, grouped by what it is for. Unless a row
says otherwise, a setting of the server must be the same on every server of a deployment
([operating.md, "Running on several servers"](operating.md#running-on-several-servers)). `server/src/config.ts`
is the source of truth.

A duration (`WLP_..._MS`) that is set and is not a number of milliseconds the platform can use stops the
server when it starts, with one line that names the variable (`[wlp] WLP_IDLE_SUSPEND_MS must be a number
of milliseconds of at least 1000, or not set for its default.`). One that is not set takes its default.
A count (`WLP_DAILY_SANDBOX_SECONDS`, `WLP_MAX_KEPT_SANDBOXES`, `WLP_USAGE_HOLD_SECONDS`, the `WLP_FACTORY_*`
settings, the rate limits) that is not a whole number in its range stops the server the same way.

## Server basics

| Variable | Effect |
|---|---|
| `WLP_DEMO` | `1`: offer the demo sign-in (scripted model, no ChatGPT account). `scripts/dev.sh` sets it |
| `WLP_ALLOWED_EMAILS`, `WLP_ALLOWED_USERS` | who may sign in with ChatGPT: account emails and user ids (`u_...`), comma-separated. Unset, both: anyone with a ChatGPT account. Asked at the sign-in and at every call, so a removal holds at once |
| `WLP_ACCOUNT_EMAILS` | comma-separated seeds such as `owner@example.com=u_existing`. At the first sign-in for each verified email, the platform records the configured uid. Existing entries keep their uid when seeds change or are removed. Invitation rules still apply to the resolved uid and email |
| `WLP_SECRET` | signs tokens; at least 16 characters (`openssl rand -hex 32`). When unset one is generated in `.data/secret`. Required with a remote engine (`RIVET_ENDPOINT`): the server refuses to start without it |
| `WLP_WEB_ORIGINS` | origins the web app may connect from, comma-separated (default `localhost:5173`, `127.0.0.1:5173`) |
| `WLP_HTTP_PORT`, `PORT` | the port of the server's own routes (`WLP_HTTP_PORT` first, then `PORT`, which Rivet Cloud sets on its nodes; default 6440). [operating.md](operating.md#running-on-several-servers) lists the routes |
| `WLP_HTTP_HOST` | the address they bind (default `127.0.0.1` with the local engine, `0.0.0.0` with a remote one) |
| `WLP_WEB_DIR` | the web app's built files (`web/dist`), for the server to serve on that port; unset, it serves none. `server/Dockerfile` sets it |

## Engine and browser connection

| Variable | Effect |
|---|---|
| `RIVET_ENDPOINT` (or the older `RIVET_ENGINE`), `RIVET_NAMESPACE`, `RIVET_TOKEN`, `RIVET_POOL`, `RIVET_NODE_VERSION` | RivetKit's own: the engine to join instead of starting a local one, the namespace, the node token, the pool (default `default`) and a number that goes up with every deploy |
| `NODE_ENV` | `production` with a remote engine: RivetKit then never starts an engine of its own |
| `RIVET_RUN_ENGINE_PORT` | RivetKit's own: the port of the local engine it starts (default 6420), for a second development server on one machine. The engine also binds the port after it and the tenth after it; the web app is then built with `VITE_WLP_ENDPOINT` naming it |
| `WLP_PUBLIC_ENDPOINT` | the Rivet endpoint browsers connect to, without a namespace or a token, which the server tells the web app. Unset: the web app uses `VITE_WLP_ENDPOINT` |
| `RIVET_ADMIN_TOKEN` | the engine's admin token, a secret: the server issues the short-lived tokens browsers connect with. Needs `WLP_PUBLIC_ENDPOINT`. Unset, as with the local engine: browsers are handed no token |
| `WLP_TOKEN_ENDPOINT` | optional private route to the same engine for issuing those tokens (default `WLP_PUBLIC_ENDPOINT`); no query string or fragment |
| `WLP_CONNECTION_TOKEN_TTL_MS` | how long such a token lasts (default one hour; from one minute to 24 hours) |
| `WLP_CLIENT_IP_HEADER` | the header a trusted ingress writes with the client's address; unset, no per-address limit applies ([operating.md, "Public HTTP rate limits"](operating.md#public-http-rate-limits)) |
| `WLP_API_ADDRESS_PER_MINUTE`, `WLP_API_TOKEN_PER_MINUTE`, `WLP_API_FAILURES_PER_MINUTE`, `WLP_WEBHOOK_REFUSALS_PER_MINUTE`, `WLP_RUNNER_POLLS_PER_MINUTE`, `WLP_RUNNER_CONNECTIONS_PER_MINUTE` | the public HTTP rate limits (defaults 240, 60, 12, 30, 240 and 120 a minute; each from 1 to 1,000,000). [operating.md](operating.md#public-http-rate-limits) says what each covers |

## Sign-ins

| Variable | Effect |
|---|---|
| `WLP_SIGNIN_KEY` | what the key that encrypts sign-ins and secrets is derived from; at least 32 characters, the same on every server. Unset: derived from `WLP_SECRET`. Setting it lets `WLP_SECRET` change without every user signing in again |
| `WLP_WINDLASS_BIN` | a Windlass executable on the server, for the sign-in and model-list commands (a path, or a name on `PATH`; default `windlass`). `server/Dockerfile` puts one at `/usr/local/bin/windlass` and sets this |
| `WLP_SIGNIN_RUNNER` | `local` or `docker`; default: `local` when `WLP_WINDLASS_BIN` is set, else `docker` with Docker sandboxes, else `local` |
| `WLP_SIGNIN_TMPDIR` | where the local runner makes its private directories (default `/dev/shm`, else the system's temporary directory) |
| `WLP_LOGIN_TTL_MS` | how long a sign-in attempt stays open (default 10 minutes) |

## Sessions and sandboxes

| Variable | Effect |
|---|---|
| `WLP_SANDBOX` | `docker` (default), `e2b` ([operating.md, "E2B"](operating.md#e2b)) or `fake` |
| `WLP_ALLOW_DOCKER_HOSTED` | `1`: allow `WLP_SANDBOX=docker` with a remote engine. Without it the server refuses, since hosted agents would run on the server host |
| `WLP_SANDBOX_IMAGE` | base image for the Docker layer, or the private output tag for either variant of `sandbox/build.sh`. By default the build publishes `windlass-platform-sandbox:latest` for base or `windlass-platform-sandbox:shots` for shots |
| `WLP_SANDBOX_SHOTS_IMAGE` | screenshots image for the Docker layer and local runner builds (default `windlass-platform-sandbox:shots`) |
| `WLP_TURN_TIMEOUT_MS` | how long one turn may run (default 45 minutes). The durations that keep its access token fresh are constants and hold for a turn of any length |
| `WLP_ACP_IDLE_MINUTES` | how long a Claude Code, OpenCode or Codex agent may send nothing, with no call of its own running and no question waiting for a person, before the platform ends its turn (default 10). The turn ends sooner, as a usage limit, when OpenCode logs that it gave up on the provider's rate limit |
| `WLP_QUESTION_TIMEOUT_MS` | how long a question waits for an answer before the platform declines it (default 10 minutes) |
| `WLP_SERVER_APPROVAL_TTL_MS` | how long an approval of a project's MCP server is remembered for its user (default and most: 30 days, which is how long Windlass keeps its own). A shorter time is for the checks |
| `WLP_SNAPSHOTS` | `on` enables post-setup snapshots for Docker Windlass sessions. Defaults to `off`. |
| `WLP_E2B_SNAPSHOTS` | `on` enables post-setup snapshots for hosted E2B sessions ([E2B setup snapshots](#e2b-setup-snapshots)). Defaults to `off`. Independent of `WLP_SNAPSHOTS` |
| `WLP_E2B_SNAPSHOT_MAX`, `WLP_E2B_SNAPSHOT_USER_MAX`, `WLP_E2B_SNAPSHOT_MAX_GB` | with `WLP_E2B_SNAPSHOTS=on`: the most snapshots the deployment keeps at E2B (default 10), the most one user keeps (default 3), and the most a sandbox's disk may hold to be saved, in GiB (default 4) |
| `WLP_SNAPSHOT_MIN_SETUP_MS` | Minimum successful setup duration for saving a snapshot. Defaults to 30000 and can be raised. |
| `WLP_SNAPSHOT_MACHINE_MAX_GB` | GB (decimal, above 0) of Docker setup snapshots on the platform's own Docker (default 10). Once set, also the most a machine's `--snapshot-disk` can give ([Snapshot storage limits](#snapshot-storage-limits)) |
| `WLP_SNAPSHOT_USER_MAX_GB` | GB of one user's snapshots on the platform's own Docker (default 2). Once set, also the most a machine's `--snapshot-user` can give |
| `WLP_KEEP_FREE_MIN_GB` | GB (0 or more) of free disk the platform's own Docker keeps: below it snapshots are evicted oldest-first, and neither snapshots nor Git mirrors are written (default 40). Once set, also the least a machine's `--keep-free` can give |
| `WLP_SETUP_TIMEOUT_MS` | how long a repository's setup command may run in a new sandbox before the platform stops it (default 10 minutes) |
| `WLP_MODEL_RELAY` | `off`: Windlass turns get their access token in a file in the sandbox, as before the relay. Unset or `on` (default): hosted Docker sends Windlass's model requests through the relay when its image's Windlass is 0.6.0 or later. So do machines whose runner says `modelRelay`, and E2B with `WLP_MODEL_RELAY_URL` set and `WLP_E2B_WINDLASS_VERSION` 0.6.0 or later ([model-relay.md](model-relay.md)) |
| `WLP_MODEL_RELAY_URL` | the hostname of its own at which E2B sandboxes reach the model relay route: `https://<DNS name>`, no port and no path, routed to this server as `WLP_PUBLIC_URL` is. On it the server answers only `/model-relay/v1/models` and `/model-relay/v1/responses`. E2B's `restricted` and `none` allow it in place of `api.openai.com`. Unset (default): E2B turns get their access token in the sandbox, and the server says so at startup ([model-relay.md](model-relay.md#where-the-relay-runs)) |
| `WLP_MODEL_RELAY_REQUESTS` | the most model requests in flight through the hosted relay, and through the E2B relay route of one server process (each process has its own), for the whole deployment (default 64, 1 to 4096). Per turn the limit stays 8, and per user 16 |
| `WLP_IDLE_SUSPEND_MS` | how long after a session's last turn ended its sandbox is suspended (default 10 minutes) |
| `WLP_IDLE_DESTROY_MS` | how long after its last use a sandbox is removed with its files; the timeline stays (default 7 days). E2B keeps a paused sandbox for as long as it is not killed and does not bill it, so a deployment there can set this to years: then a sandbox goes only with its agent |

## Usage limits

| Variable | Effect |
|---|---|
| `WLP_DAILY_SANDBOX_SECONDS` | how many seconds a user's sandboxes may run in one UTC day, all of them together (default 7200, two hours; at least 60), or `unlimited` ([architecture.md, "Usage and limits"](architecture.md#usage-and-limits)) |
| `WLP_MAX_KEPT_SANDBOXES` | how many sandboxes a user may keep at the same time, running or paused (default 5; at least 1), or `unlimited` |
| `WLP_USAGE_HOLD_SECONDS` | how much of the day's allowance a running sandbox reserves at a time, and so how often its session reports (default 300, from 5 to 3600). A shorter time is for the checks |

## E2B

Read only with `WLP_SANDBOX=e2b` (`server/src/sandbox/e2b/config.ts`). The defaults are sized for E2B's free
Hobby plan. [operating.md, "E2B"](operating.md#e2b) explains each.

| Variable | Effect |
|---|---|
| `E2B_API_KEY` | the E2B account's API key. Required: without it the server does not start |
| `WLP_E2B_TEMPLATE`, `WLP_E2B_SHOTS_TEMPLATE` | the templates sandboxes are made from (defaults `windlass-platform-sandbox` and `windlass-platform-sandbox-shots`), for the build scripts and the server |
| `WLP_E2B_DEPLOYMENT` | marks every sandbox of this deployment in its metadata (default `default`); different for another deployment that shares the E2B account |
| `WLP_E2B_MAX_RUNNING` | how many of the deployment's sandboxes may run at the same time (default 3) |
| `WLP_E2B_IDLE_TIMEOUT_MS` | a sandbox's own timeout while no turn runs in it (default two minutes) |
| `WLP_E2B_TURN_LEASE_MS` | a sandbox's own timeout while a turn runs, renewed every third of it (default three minutes) |
| `WLP_E2B_MAX_RUNTIME_MS` | how long the plan lets a sandbox run without a pause (default one hour, the Hobby plan's; 86400000 on Pro) |
| `WLP_E2B_PAUSE` | `0` for an account that cannot pause: sandboxes are killed where they would be paused (default 1) |
| `WLP_E2B_WINDLASS_SANDBOX` | `1`: promise Windlass's own sandbox in the E2B profile, once `scripts/e2b-check.ts` has shown it works (default 0) |
| `WLP_E2B_OPEN_PROFILE` | `1`: also offer "E2B, microVM only" (`e2b-open`) (default 0: listed, not offered) |
| `WLP_E2B_WINDLASS_VERSION` | the Windlass version in the template, to show before the first sandbox was made (default: learned from the first sandbox). The model relay is used on E2B only when this says 0.6.0 or later |
| `WLP_E2B_CPU`, `WLP_E2B_MEMORY_MB` | `sandbox/e2b/build.sh` only: the size of every sandbox made from the template (default 1 vCPU, 1024 MiB) |

## The bucket for agent memory and screenshots

[operating.md, "The bucket for agent memory"](operating.md#the-bucket-for-agent-memory) says how to set it up.

| Variable | Effect |
|---|---|
| `WLP_BUCKET_ENDPOINT` | the store's S3 endpoint without the bucket: for R2, `https://<account id>.r2.cloudflarestorage.com` |
| `WLP_BUCKET_NAME` | the bucket |
| `WLP_BUCKET_ACCESS_KEY_ID`, `WLP_BUCKET_SECRET_ACCESS_KEY` | an access key that may read, write and delete objects in that bucket. The second is a secret |
| `WLP_BUCKET_REGION` | optional: the region the signatures name (default `auto`, which is R2's) |
| `WLP_BUCKET_STYLE` | optional: `path` (default) or `virtual`, where the bucket's name goes in an address |
| `WLP_BUCKET_PREFIX` | optional: put before every key, for a bucket that is shared |
| `WLP_BACKUP_MAX_BYTES` | optional: the largest copy of an agent's memory that is kept (default 67108864, 64 MiB) |

With none of the first four set the feature is off; with only some, it is off and the server says which are
missing when it starts.

## GitHub

[operating.md, "The GitHub App"](operating.md#the-github-app) says how to register the app.

| Variable | Effect |
|---|---|
| `WLP_GITHUB_APP_ID`, `WLP_GITHUB_APP_SLUG`, `WLP_GITHUB_CLIENT_ID` | the deployment's GitHub App: its numeric id, its name as its address has it, its client id. With these and the two below, users can connect GitHub; with none, nothing of GitHub is offered; with some, GitHub is off and the server says which are missing |
| `WLP_GITHUB_CLIENT_SECRET`, `WLP_GITHUB_PRIVATE_KEY` | the app's client secret and private key, both secrets. The key as the `.pem` file has it, with `\n` for its line breaks, or in base64. Where a secret store holds less, the base64 in pieces `WLP_GITHUB_PRIVATE_KEY_1`, `_2`, ... |
| `WLP_GITHUB_API_URL`, `WLP_GITHUB_URL` | GitHub's API and GitHub itself (defaults `https://api.github.com` and `https://github.com`) |
| `WLP_GITHUB_WEBHOOK_SECRET`, `WLP_GITHUB_WEBHOOK_SECRET_PREVIOUS` | the webhook's secret (at least 32 characters) and the previous one while it is rotated. Unset: no webhook route |
| `WLP_GITHUB_POLL_FALLBACK` | `1`: keep polling GitHub, more slowly, beside the webhook; requires `WLP_GITHUB_WEBHOOK_SECRET` |

## Machines

| Variable | Effect |
|---|---|
| `WLP_MACHINES` | `1`: users may pair machines of their own ([machines.md](machines.md#turning-machines-on)); default off |
| `WLP_PUBLIC_URL` | the platform's address for runners: an `https://` origin, or `http://` on a loopback address, with no path. Required with `WLP_MACHINES=1` and a remote engine; with the local one, default `http://localhost:<WLP_HTTP_PORT>` |
| `WLP_RUNNER_IMAGE` | the runner image the Machines page names, `<name>@sha256:<64 hex>`; unset: none is published yet. Set to anything else, the server does not start |

The runner's own variables (`WLP_RUNNER_CPUS`, `WLP_RUNNER_STATE_DIR`) are in the
[runner reference](../web/src/docs/content/runner.md#environment).

## Work items

Operators can set [per-user limits](#per-user-limits), including a daily token cap and the feature budget multiplier.

| Variable | Effect |
|---|---|
| `WLP_ITEMS` | `1`: every user of the deployment may file work items ([work-items.md](work-items.md#turning-work-items-on)); default off. The `WLP_FACTORY_RUNNING_TURNS` ceiling holds either way |
| `WLP_FACTORY_RUNNING_TURNS` | how many turns a user may have running at once, their own and their work items' together (default 6, from 1 to 100): also the ceiling on the user's own running agents |
| `WLP_FACTORY_TURNS` | how many of those a user's work items may take (default 5, from 1 to 100); held to one less than `WLP_FACTORY_RUNNING_TURNS`, and to 0 when only one running turn is allowed |
| `WLP_FACTORY_HOSTED_RUNNING` | how many of a user's hosted sandboxes may run at once for a work item's turn to start beside them (default 3) |
| `WLP_FACTORY_REVIEW_CAP` | how many of a user's work items may be in review before new ones wait (default 6) |
| `WLP_FACTORY_ITEM_TOKENS`, `WLP_FACTORY_ITEM_TURNS`, `WLP_FACTORY_ITEM_ACTIVE_SECONDS`, `WLP_FACTORY_ITEM_HOSTED_SECONDS` | a new work item's budget: tokens, turns, seconds of working time and seconds of hosted sandbox time (defaults 6,000,000, 14, 14400 and 7200) |
| `WLP_FACTORY_GITHUB_ITEMS_PER_DAY`, `WLP_FACTORY_GITHUB_DRAFTS` | how many items a user may have filed from GitHub issues in a day, and how many such drafts may wait (defaults 20 and 20) |
| `WLP_FACTORY_ORCHESTRATE` | `0`: hide the Orchestrate control and refuse new orchestrated filings (default on) |
| `WLP_FACTORY_REVIEWER` | `on`: give new items on a hosted profile that isolates commands a second review (default off) |
| `WLP_FACTORY_SCREENSHOTS` | `off`: no work item of the deployment takes screenshots, whatever its repository's setting says. Sessions get the base image or template, never the screenshots one (also a builder that reconnects to a sandbox made before), agents are not offered screenshots in their reports, plans see no machine with screenshots, and a repository's setting cannot be turned on (one saved on can still be turned off). `on` or unset: each repository's setting decides (default on) |
| `WLP_FACTORY_ATTACHMENT_BYTES`, `WLP_FACTORY_ATTACHMENTS_PER_ITEM`, `WLP_FACTORY_ATTACHMENT_ACCOUNT_BYTES`, `WLP_FACTORY_ATTACHMENT_DAYS` | screenshots on work items: bytes per screenshot (default 2 MiB), screenshots per item (40), bytes per account (1 GiB), and days they are kept after the item ended (180) |

## Web app

Read at build time (Vite) unless a row says otherwise.

| Variable | Effect |
|---|---|
| `VITE_WLP_ENDPOINT` | the Rivet endpoint the web app connects to when the server names none, as a development server does (default `http://localhost:6420`). A server with `WLP_PUBLIC_ENDPOINT` names its own, and this is not needed |
| `VITE_WLP_API` | where the web app asks for `/platform/info` and `/platform/connection` (default: the endpoint's host on port 6440 when the endpoint is on 6420, else `http://localhost:6440`; a web app served by the server asks the address it was loaded from) |
| `VITE_WLP_MOCK` | `1`: the web app runs on its mock, with no server |
| `VITE_WLP_SITE_URL` | the origin the public pages are canonical at (default `https://windlass.parthg.dev`) |
| `VITE_WLP_ACCESS_URL` | where "Request access" leads (a form or a `mailto:` link); unset, the public pages offer "Sign in" alone and say that access is by invitation |

## Build scripts

| Variable | Effect |
|---|---|
| `WINDLASS_BINARY` | the executable `sandbox/build.sh` and `sandbox/e2b/build.sh` put in the image (default: the released Windlass that `sandbox/fetch-windlass.sh` pins by tag and SHA-256, and fetches) |
| `WINDLASS_RELEASE_DIR` | where `sandbox/fetch-windlass.sh` keeps the releases (default `~/.cache/windlass-platform/windlass-<tag>`) |
| `WLP_SANDBOX_VARIANT` | `shots`: build the screenshots image or template (default `base`) |
| `WLP_RUNNER_HARNESSES` | `scripts/runner-build.sh`: space-separated harnesses to include, such as `claude` |
| `WLP_RUNNER_PLATFORMS`, `WLP_RUNNER_ARCHIVE` | `scripts/runner-build.sh`: build for several platforms (`linux/amd64,linux/arm64`) into an OCI archive, and where to write it |

## Checks and the fake layer only

| Variable | Effect |
|---|---|
| `WLP_FAKE_DELAY_MS` | delay between replayed events (default 15) |
| `WLP_FAKE_BACKUP_DIR` | a directory that stands in for the bucket; the fake sandboxes then hold Windlass's sessions as E2B's do |
| `WLP_FAKE_RESERVE_FAULT` | for `scripts/e2e.ts`: makes the answers between a session and its user's actor about sandbox time go wrong (`lose:<n>`, `lose-renewal:<n>`, `down:<ms>`, comma-separated) |
| other `WLP_FAKE_*` | fault switches the checks set for themselves; see `server/src/sandbox-fake.ts` |
| `WLP_CHECK_ENGINE`, `WLP_RUNNER_CHECK_IMAGE`, `WLP_PROBE_MAX_BYTES`, `WLP_PROBE_IDLE_MS` | checks against a real engine, a prebuilt runner image, and the socket probe ([development.md](development.md#checks)) |

## Local data

Actor data is in `.data/.rivetkit`; stop the server and remove that directory to start from nothing.
`sandbox/cleanup.sh --keep-image` removes every container and volume this project made; the sign-ins in the
users' actors go with the actor data.

## Docker setup snapshots

A snapshot lives on the Docker daemon that ran setup. Windlass keeps one image per user and repository there. The cache key includes the image ID, OS and architecture, sandbox profile, screenshots variant, network mode, setup text, lockfile contents and toolchain pins. Every `package.json` and recognized dependency file contributes its Git blob ID. A hosted deployment keeps its index identity in `snapshot-deployment` under `RIVETKIT_STORAGE_PATH`. Preserve that directory when replacing the server. If the tree has no recognized lockfile or GitHub cannot provide a complete tree, the session uses the ordinary setup path. Editing setup or reconnecting GitHub changes the settings generation. A new session verifies access and the fetched revision before it skips setup.

Each Docker daemon allows 10 GB of incremental image storage by default, with a 2 GB share per user. Eviction removes the least recently used images first. Sweeps and new saves evict oldest-first when the Docker filesystem has less than the keep-free amount free (40 GB by default), and no snapshot or Git mirror is written below it. Images expire after 14 days unused. An evicted image still counts toward both caps until its last container releases it.

### Snapshot storage limits

On the platform's own Docker, `WLP_SNAPSHOT_MACHINE_MAX_GB`, `WLP_SNAPSHOT_USER_MAX_GB` and `WLP_KEEP_FREE_MIN_GB` set the three limits; each one not set keeps its default (10, 2 and 40 GB). Keep-free is 40 GB because the engine on a self-hosted platform host sizes its log store from the free disk it finds at start, and 15 GB, the old default, is too little there.

On a machine, its owner sets them with the runner's `--snapshot-disk`, `--snapshot-user` and `--keep-free` ([machines.md](machines.md#snapshot-storage-on-this-machine)). The settings above that are set also hold the machines: a ceiling on the two sizes and a floor on keep-free. A machine can choose less space or more free disk than the deployment, never more space or less free disk. With none of them set, the deployment holds no machine to anything, and a small machine can lower keep-free as far as it likes. The platform sends its caps in the signed welcome to runner 0.3.2 or later, and the Machines page shows the limits in force under **Snapshot storage**. Runner 0.3.1 and older take no flags and get no caps: they keep their built-in 10 GB, 2 GB and 15 GB free, and the page says so.

Machine snapshots require signed runner connections. Create and save use the authenticated protocol 2 session. The runner verifies each retention answer with the certified online platform key against its paired root. Protocol 1 sessions start cold. Connected runners check retention every 15 minutes and retire images from previous pairings. Hosted Docker uses the server's local index.

## E2B setup snapshots

With `WLP_E2B_SNAPSHOTS=on`, a hosted E2B session saves a snapshot after setup by the same rules as Docker: the setup succeeds on the repository's default branch, takes at least `WLP_SNAPSHOT_MIN_SETUP_MS`, and receives no repository secrets. A later session of the same user and repository starts from it, after the same GitHub checks. Snapshots are never shared between users, even for the same public repository. The cache key holds the template's name and the build its tag points at in place of the image ID, then the profile, screenshots variant, network mode and hosts, setup command and dependency files. Rebuilding the template starts every session cold until it saves again.

The snapshot is E2B's filesystem-only snapshot (`Sandbox.createSnapshot` with `mode: "filesystem"`). A sandbox made from it boots from that disk with none of the source's processes or memory. An account that cannot take filesystem-only snapshots saves none, and the server says so once. A memory snapshot is never taken instead. Just before the save, a check runs as root. It removes the platform's staging under `/tmp` and refuses the save if Windlass's data directory holds any file, or if the workspace's git configuration holds a credential, extra header or URL rewrite. A credential store, a user in a remote URL, or a GitHub-token-shaped or model-relay-placeholder-shaped string under `/workspace/.git`, `/home/agent`, `/tmp` or `/var/tmp` also refuses it. Each snapshot holds a root-owned record of its deployment, user, repository and key. A sandbox made from it is used only when that record matches.

The deployment keeps one snapshot per user and repository. A newer one replaces it, and a lookup removes one saved under an earlier setup or GitHub connection. Snapshots expire after 14 days. The oldest go first when a user has more than `WLP_E2B_SNAPSHOT_USER_MAX` or the deployment more than `WLP_E2B_SNAPSHOT_MAX`. Snapshots are named by digests, so any server of the deployment sees the same index. E2B publishes no price for keeping a snapshot: it bills running sandboxes by the second and lists disk as free (read 2026-11-22). Saving costs the seconds the source sandbox runs while E2B writes the image. Turning the switch off keeps snapshots already saved. `scripts/e2b-cleanup.ts --kill` deletes them with the deployment's sandboxes.

Factory placement gives a place that holds a fresh snapshot of the subtask's repository a bonus worth two free slots (`server/src/factory/placement.ts`). That covers hosted Docker, hosted E2B and each machine. It only ranks places the plan allows that can take the subtask now. It never puts an alternative ahead of the preferred place unless that alternative ranks higher without the bonus. A person's own session always runs where they chose.

To measure startup on a development host, run `WLP_SANDBOX=docker pnpm --filter @windlass-platform/server exec tsx ../scripts/e2e.ts --snapshot-benchmark` from the repository root. It uses a small local fixture repository served by a GitHub App stand-in and runs three alternating pairs of scripted turns with snapshots off and on. Each row reports elapsed time from sandbox creation to the first Windlass event, setup duration and their difference in milliseconds.

## Per-user limits

`WLP_DAILY_TOKENS` sets the model token cap per user per UTC day. Its default is `unlimited`. A positive integer applies to hosted sessions and Windlass on paired machines, which receive the platform’s model credential. Machine-local Claude Code and OpenCode use the machine owner’s subscription. Input and output are counted as the model reports them, including compaction. Cached input and reasoning are already included. Recording starts when this version is installed.

`WLP_FACTORY_FEATURE_MULTIPLIER` sets the starting feature budget as a multiple of a Quick item’s budget (1–100, default 3). Per-item budgets and this multiplier take effect when an item is created. An existing item keeps its budget and any increases approved for that item. The daily model cap applies across items regardless of their individual budgets.

Run the command from `server/` in the operator environment with the normal service signing key.

```sh
node --import tsx src/set-user-limit.ts u_example dailyTokens 18000000
node --import tsx src/set-user-limit.ts u_example item.turns 20
node --import tsx src/set-user-limit.ts u_example item.turns default
node --import tsx src/set-user-limit.ts u_example --history
```

Use `default` to remove an override and inherit the deployment setting. Each change is recorded in the existing user actor with its timestamp, operator’s OS account, old and new effective values, and the resulting overrides. The history command shows 100 changes newest first. Pass its lowest ID after `--history` for the previous page. Operators using a shared OS account appear under that account name. Users can read their effective limits on **Usage**.

| Setting | Accepted values |
| --- | --- |
| `runningTurns`, `factoryTurns`, `hostedRunning`, `featureMultiplier` | 1–100. The effective Factory share leaves one turn for personal prompts. |
| `reviewCap`, `item.turns` | 1–1,000 |
| `item.tokens` | 1–1,000,000,000 |
| `item.activeSeconds`, `item.hostedSeconds` | 1–604,800 |
| `githubItemsPerDay`, `githubDrafts`, `attachments.perItem` | 1–1,000,000 |
| `attachments.bytes`, `attachments.days` | 1–2,097,152 bytes per screenshot and 1–36,500 days of retention |
| `attachments.accountBytes`, `dailyTokens` | Positive safe integer. `dailyTokens` also accepts `unlimited`. |
| `dailySeconds`, `maxKept` | 60–86,400 hosted sandbox seconds and 1–1,000 kept hosted sandboxes. Both accept `unlimited`. |

Factory turns already admitted finish their step, so reported usage can exceed the cap. Further Factory turns wait until 00:00 UTC or an operator raises the cap. Interactive prompts show the reason immediately.
