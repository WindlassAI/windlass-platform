# Development

[AGENTS.md](../AGENTS.md) links the scoped agent guides and the commands for checking changes in each area.

Running the platform from a checkout, the layout of the repository, the checks, and how the public pages
are built. [CONTRIBUTING.md](../CONTRIBUTING.md) says how to send a change.

## Run it

Use Node.js 22.22.2 (or a newer patch in 22.x) and pnpm 11.25.0 (`corepack enable pnpm`), on a machine the
local Rivet engine supports, such as Linux x64 or arm64. The README's quick start runs fake sandboxes, which
replay recorded Windlass sessions and need no Docker, account or API keys.

For real containers, install Docker as well. The Windlass the platform runs is the released 0.7.1, which the
build scripts fetch by themselves (`sandbox/fetch-windlass.sh`: the release is pinned there by tag and by the
SHA-256 of each executable, and a file that does not match is not installed).

The server and Docker image build require Windlass 0.4.0 or later. Each turn checks for host tools in its engine’s `initialize` response before opening the session. Keep the Docker image and E2B template at 0.7.1 or later when rolling back. Windlass 0.6.0 cannot open sessions written by 0.7.x.

```sh
pnpm install

# Build the sandbox image, with the released Windlass. For a Windlass that is not released yet:
# WINDLASS_BINARY=/path/to/windlass-linux-<arch> sandbox/build.sh
sandbox/build.sh
WLP_SANDBOX_VARIANT=shots sandbox/build.sh  # browser image for opted-in work items

scripts/dev.sh                              # the server: Rivet endpoint on http://localhost:6420, its own routes on :6440, demo sign-in on
pnpm --filter @windlass-platform/web dev    # the web app on http://localhost:5173
```

Open http://localhost:5173. "Try the demo" needs no account: it runs Windlass's real engine and real tool calls in
a real container, with a scripted model in place of ChatGPT. "Continue with ChatGPT" runs on your own plan.

When the browser is on another machine, forward ports 5173, 6420 and 6440, or set `VITE_WLP_ENDPOINT` (web) and
`WLP_WEB_ORIGINS` (server) to the addresses you use (the web app looks for the server's routes on the endpoint's
host, port 6440, unless `VITE_WLP_API` says otherwise).

Without Docker, `WLP_SANDBOX=fake scripts/dev.sh` runs in-memory sandboxes that replay recorded Windlass runs, and
`VITE_WLP_MOCK=1 pnpm --filter @windlass-platform/web dev` runs the web app with no server at all.


## Layout

| Path | What it holds |
|---|---|
| `server/src/contract.ts` | The contract between the actors and the web app: types only |
| `server/src/actors/` | The actors registered in `server/src/registry.ts`, including `login`, `accountEmail`, `user`, `agentSession`, `machine`, `machinePairing` with `pairingDirectory`, and `workItem`. `user-machines.ts` and `user-items.ts` hold what the `user` actor does for machines and for work items (the index, the turn queue, the API tokens), `session-inbox.ts` what a session does for its item |
| `server/src/index.ts`, `platform-info.ts`, `runner-routes.ts`, `api-routes.ts` | The server: one Rivet node, and its HTTP routes (`/platform/info`, `/platform/connection`, `/health`, GitHub and Linear callbacks and webhooks, the model relay, billing, runner and item routes) |
| `server/src/web.ts` | The web app's built files, served on the same port where `WLP_WEB_DIR` names them |
| `server/src/connection-tokens.ts` | The tokens browsers connect with: issued by the engine for the admin token, kept and handed out by each server |
| `server/Dockerfile` | The server as an image, for the self-host kit, a Rivet Cloud cluster or a machine of your own ([operating.md](operating.md#running-on-several-servers)) |
| `server/src/sandbox/api.ts` | The sandbox layer's interface; everything about Docker and the `windlass` command line is behind it |
| `server/src/sandbox/` | That layer on Docker: containers, volumes, running a turn, the hand-off of an access token to a turn, the demo scripts |
| `server/src/signin/` | The ChatGPT sign-in for every layer: Windlass's sign-in commands and where they run, the encryption, and the one place per user that asks for an access token |
| `server/src/sandbox-fake.ts` | The same interface in memory, for tests |
| `server/src/server-question.ts` | The words of the question about a project's MCP server, for each sandbox profile, and of the timeline's lines about it |
| `server/src/server-approvals.ts` | The user's remembered approvals of projects' MCP servers: what a project is, the record itself, and what a session keeps of its project's servers for its side panel |
| `server/src/submissions.ts` | A submission and its key: what a key may be, what is held against it, and how an attempt that arrives while another is being decided ends as that one does ([A message sent twice](architecture.md#a-message-sent-twice)) |
| `server/src/usage.ts` | A user's sandbox time and kept sandboxes: what is counted, the two limits, the book the `user` actor decides with, and the words of a refusal ([Usage and limits](architecture.md#usage-and-limits)) |
| `server/src/setup-command.ts`, `server/src/sandbox/setup.ts` | A repository's setup command: what it is saved for, its limits, what is kept of a run's output and what the agent is told; and the run itself in a sandbox |
| `server/src/repository-defaults.ts` | A repository's defaults for new sessions: what may be saved, and how a save writes only the fields it names ([A repository's page](github-and-repositories.md#a-repositorys-page)) |
| `server/src/repository-checks.ts` | A repository's checks: what may be saved, the list as Windlass takes it (as required checks), and how it is stored whole ([A repository's checks](github-and-repositories.md#a-repositorys-checks)) |
| `server/src/verified.ts` | What a session's work was verified with: what a turn's events come to, what is looked for in the work's changes, and the section of a pull request's description ([What a pull request shows was verified](github-and-repositories.md#what-a-pull-request-shows-was-verified)) |
| `server/src/account-models.ts` | The models a user may choose ([Models](architecture.md#models)): the list of their ChatGPT plan as the `user` actor keeps it, when Windlass is asked again, the stand-in, and how a model and an effort are held against the list |
| `server/src/account-defaults.ts`, `server/src/personal-servers.ts`, `server/src/account-secrets.ts` | What a user keeps for their account ([Account settings](github-and-repositories.md#account-settings)): the defaults for new sessions; their own MCP servers, what a name and a definition may be and how many are kept; and the secrets those read, whom they reach and how they give way to a repository's |
| `server/src/windlass-config.ts` | Windlass's own configuration file in a sandbox: what the platform writes into it for a turn (the user's own MCP servers, the repository's checks), how it is taken out again, and what a repository's own file says about checks, and that wake-ups are off (`wake.enabled: false`) for every session, since nothing delivers one while a sandbox is paused |
| `server/src/agent-publish.ts` | The agent asking the platform to publish: the tool and its server, what a request may hold, and the words of the question, of the timeline's lines and of what the agent is told |
| `server/src/repo-secrets.ts` | A repository's secrets: what may be saved, what a scope comes to in each kind of sandbox, the sealing, and taking saved values out of text |
| `server/src/bucket/`, `server/src/sandbox/backup.ts` | The object store the copies of Windlass's session data go to (S3 protocol, and a stand-in for tests), and what is copied, saved and restored |
| `server/src/github/` | The GitHub App: its tokens and API calls, connecting (the callback route), which repositories a user may work on, the git commands the platform runs in a sandbox ("GitHub"), and the reader of a commit's CI (`ci.ts`) |
| `server/src/runner/` | What the server and the runner share: a session socket's protocol and its resumable channel (`protocol.ts`, `channel.ts`), the control socket's frames and refusals (`control.ts`), and the checks both are built from (`check.ts`) |
| `server/src/machines/`, `server/src/sandbox/runner-layer.ts`, `server/src/runner-keys.ts` | A machine on the server: the one-use tickets of a session's socket and the profiles a machine offers from its report; the session's link to its runner, and what the session says when the machine does not answer; the pairing codes, and the machine keys and their signatures ([Machines of your own](machines.md)) |
| `server/src/factory/` | Work items as pure modules: the fixed sequence (`blueprint.ts`), the verdict, the budgets and waits, and the types they share ([Work items](work-items.md)) |
| `server/src/api-tokens.ts` | The API's tokens: how one is made, kept as a digest, checked and revoked |
| `sandbox/` | The sandbox image (`Dockerfile`, `build.sh`, `cleanup.sh`, `fetch-windlass.sh`, the bubblewrap seccomp profile, `wlp-run` and `wlp-shot`), the E2B template build (`e2b/`), the Claude Code harness image (`harness/`) and its credential relay (`relay/`) |
| `deploy/selfhost/` | The Docker Compose kit for one Linux host, with backups and the load test ([its guide](../deploy/selfhost/README.md)) |
| `docs/` | These developer and operator docs. The user docs are `web/src/docs/content/`, served at `/docs` |
| `runner/` | The runner program for a user’s machine. `bundle.mjs` bundles the Node executable and stages its seccomp profile. `scripts/runner-build.sh` builds the image with its `Dockerfile`. |
| `web/` | The web app (Vite, React); `src/api/rivet.ts` is the real client, `src/api/connection.ts` where it gets its connection and renews its token, `src/api/mock.ts` the mock; `src/site/` the public pages, prerendered by `site-build.ts` ([Public pages](#public-pages)) |
| `fixtures/windlass-events/` | Recorded Windlass events, used by the fake layer, the mock and the reducer's tests |
| `fixtures/mcp-repo/` | A small repository whose `.windlass/config.json` names an MCP server, and the server (Python, nothing else), for `scripts/mcp-check.ts` |
| `scripts/` | `dev.sh`, `e2e.ts` (the actors), `sandbox-check.ts` (the sandbox layer), `signin-check.ts` (the sign-ins), `connection-check.ts` and `connection-e2e.ts` (what browsers connect with, and its renewal), the stand-ins the checks use (`github-standin.ts`; `runner-fake.ts` and `runner-stub-server.ts` for a runner and for the platform), `readme-shots.mjs` (the README's screenshots, from the mock), and the checks listed under "Checks" |

## Checks

Run each TypeScript check from the project root with `cd server && npx tsx ../scripts/<name>.ts [flags]`.
Existing commands using `../scripts/locked.sh <check>.ts` from `server/` still run the same check directly.
The `pnpm e2e` and `pnpm e2e:docker` commands in `server/` are shortcuts for the actor checks.

```sh
pnpm -r typecheck
pnpm --filter @windlass-platform/web test                         # the timeline reducer against every fixture; the connection and its renewal
cd server && npx tsx ../scripts/e2e.ts                            # the actors, fake sandboxes
cd server && WLP_SANDBOX=docker npx tsx ../scripts/e2e.ts         # the actors, real containers
cd server && npx tsx ../scripts/sandbox-check.ts                  # the sandbox layer on its own
cd server && npx tsx ../scripts/mcp-check.ts                      # the question about a project's MCP server, against a real Windlass
cd server && npx tsx ../scripts/setup-check.ts                    # a repository's setup command: its rules, no server and no Docker
cd server && npx tsx ../scripts/usage-check.ts                    # sandbox time and kept sandboxes: their rules, no server and no Docker
cd server && npx tsx ../scripts/secrets-check.ts                  # a repository's secrets: its rules, no server and no Docker
cd server && npx tsx ../scripts/repository-check.ts               # a repository's defaults: its rules and saves that interleave, no server and no Docker
cd server && npx tsx ../scripts/verified-check.ts                 # a repository's checks and what a pull request says was verified: the rules, no server and no Docker
cd server && npx tsx ../scripts/verified-check.ts --docker        # and the same against a real Windlass
cd server && npx tsx ../scripts/account-check.ts                  # the account's settings: defaults, own MCP servers and their secrets, no server and no Docker
cd server && npx tsx ../scripts/idempotency-check.ts              # a message sent twice: with and without a key, through the actors on fake sandboxes, on ports of its own
cd server && npx tsx ../scripts/models-check.ts                   # a user's models: the list's rules, and the real `windlass --models` against a stand-in for the provider
cd server && npx tsx ../scripts/signin-check.ts                   # the sign-in machinery without Docker, against a stand-in for OpenAI; its last section starts a server of its own on OS-assigned ports
cd server && npx tsx ../scripts/connection-check.ts               # the tokens browsers connect with: a stand-in for the engine
cd server && npx tsx ../scripts/access-check.ts                   # who may sign in: the invitation list and the demo
cd server && npx tsx ../scripts/web-stage-check.ts                # the image's web stage copies every shared file Vite loads
cd server && npx tsx ../scripts/web-files-check.ts                # the web app's files as the server serves them
cd server && npx tsx ../scripts/connection-e2e.ts                 # the web app's client through an engine whose tokens run out
cd server && npx tsx ../scripts/harness-check.ts                  # recorded ACP agent interactions
cd server && npx tsx ../scripts/attachments-check.ts              # work item attachments
cd server && npx tsx ../scripts/review-check.ts                   # the report tool
cd server && npx tsx ../scripts/reviewer-task-check.ts            # reviewer task text
cd server && npx tsx ../scripts/shot-check.ts                     # screenshot helper; --docker exercises the browser
cd server && npx tsx ../scripts/github-check.ts                   # GitHub stand-in and git operations
cd server && npx tsx ../scripts/webhook-check.ts                  # GitHub webhook delivery and retries
cd server && npx tsx ../scripts/backup-check.ts                   # backup and restore with a stand-in bucket
cd server && npx tsx ../scripts/e2b-provider-test.ts              # E2B provider with its in-memory client
cd server && npx tsx ../scripts/e2b-check.ts                      # live E2B; requires E2B_API_KEY
cd server && npx tsx ../scripts/e2b-backup-check.ts               # live E2B and bucket; requires both configurations
```

The machine and work item checks use the same command. `runner-check.ts` builds its own runner from
the pinned sandbox, or uses the image named by `WLP_RUNNER_CHECK_IMAGE`.

```sh
cd server && npx tsx ../scripts/runner-protocol-check.ts          # the runner channel under the failures it will meet, on loopback sockets and a clock moved by hand
cd server && npx tsx ../scripts/runner-control-check.ts           # the control socket's frames: input that is not a frame, every refusal readable by a runner, a second runner with one key
cd server && npx tsx ../scripts/http-limits-check.ts               # public HTTP limits, two nodes, real tokens and signed deliveries
cd server && npx tsx ../scripts/machine-check.ts                  # pairing, keys, removal and the 90-day expiry, through the real routes and actors, a second node and the runner's own control loop
cd server && npx tsx ../scripts/runner-e2e.ts                     # sessions on a machine through the real server and actors, with a runner stood in for in the process; no Docker
cd server && npx tsx ../scripts/runner-socket-probe.ts            # one throwaway actor on a local engine
cd server && npx tsx ../scripts/factory-check.ts                  # work items' sequence, verdicts and budgets as tables of facts, and the reader of CI against the GitHub stand-in
cd server && npx tsx ../scripts/factory-e2e.ts                    # work items through the real actors on fake sandboxes and the GitHub stand-in
cd server && npx tsx ../scripts/runner-check.ts                   # the real runner in real containers, against a stand-in of the platform and the real routes: pairing, outages, refusals, prune
```

`pnpm test` runs the factory, core, usage and resume shards in sequence. [testing.md](testing.md)
maps the scripts to CI jobs and branch triggers. The following checks need additional local services or images.

```sh
cd server && pnpm exec tsx ../scripts/claude-relay-docker-check.mjs sha256:<local Claude image id>   # the credential relay in real containers (sandbox/relay/README.md)
server/node_modules/.bin/tsx scripts/selfhost-ingress-check.ts deploy/selfhost/tunnel.example.yml <app host> <engine host>   # the tunnel's ingress rules, offline
node scripts/selfhost-csp-check.cjs http://127.0.0.1:16440                                         # the built app's content security policy, with Playwright
```

The last two are described in the [self-host guide](../deploy/selfhost/README.md).

`runner-check.ts` plays a five-minute outage of the machine's network and a two-minute sleep of the machine
in wall time, so it takes some minutes.

The probe measures raw text messages up to `WLP_PROBE_MAX_BYTES` (default 32 MiB), waits without sending
for `WLP_PROBE_IDLE_MS` (default one minute), then drains its own node. To use an existing cluster, set
`WLP_CHECK_ENGINE` to its public engine origin, `RIVET_NAMESPACE`, `RIVET_POOL` to an existing pool
reserved for the probe, and `RIVET_ADMIN_TOKEN` in the environment. It uses a scoped token for its client
and removes its actor when it finishes.

`connection-check.ts` also runs against a real engine when it is given one, with about ten requests that issue
and read back tokens and nothing else (`WLP_CHECK_ENGINE=https://<name>-api.onrivet.dev RIVET_ADMIN_TOKEN=...`).
The local engine asks for no token, so `connection-e2e.ts` puts a front before it that asks for one as a
cluster's engine does, with tokens that last twelve seconds, and runs real turns through it with the web
app's own client: past a token's expiry, across a dropped connection, and with a clock that runs behind.

Local checks can run together, including multiple copies of the same check. Each starts its own
listeners on OS-assigned ports. RivetKit requires an engine port before startup and opens two more
at base + 1 and base + 10. Each check reserves the engine and HTTP port numbers on loopback UDP and
probes them on TCP before starting the server. The UDP sockets stay bound until the check exits,
so other checks skip those ports even during a server restart. `machine-check.ts` waits for its
machines' state changes. There is no host-wide cap.

Docker checks resolve input images to an image ID at startup or build a labelled, private tag
and remove it when finished. Docker shares the build cache. To publish the local sandbox image,
run `sandbox/build.sh` with no image override. This command takes a nonblocking lock on
`/tmp/wlp-sandbox-publish.lock` because two publishers would both write
`windlass-platform-sandbox:latest`. For a private build, set `WLP_SANDBOX_IMAGE` to a distinct
tag and remove that tag after use. Run the host-wide `sandbox/cleanup.sh` manually on an idle host.


## Public pages

Signed-out visitors can open the landing page and the public routes listed in `PUBLIC_PAGES`. Agent sessions and account pages require sign-in. The
landing page, and any other public page (the docs, say), is prerendered at build time to static HTML, so a
visitor, a crawler or an answer engine reads it with no JavaScript at all.

- **One list.** `web/src/site/pages.tsx` lists every public page (`PUBLIC_PAGES`): its path, title,
  description, body (a React element rendered with `renderToStaticMarkup`), its Markdown for
  `llms-full.txt`, its line in `llms.txt`, and its JSON-LD. To add pages, make `PublicPage`s in a module of
  your own and spread them into that list; `web/src/site/pages.test.ts` holds every page to the rules
  (title and description lengths, one `h1`, no inline script, JSON-LD that parses, Markdown). A page's
  styles go into the app's stylesheet, imported in `web/src/main.tsx`: the public pages link the app's own.
- **The build.** `vite build` (the Dockerfile's web stage included) runs `web/site-build.ts` after the app
  is written. It renders every page into `dist/<path>/index.html` (the landing into `dist/index.html`),
  keeps the app's shell as `dist/app.html` with `noindex`, and writes `sitemap.xml`, `robots.txt`,
  `llms.txt` and `llms-full.txt` from the same list. Each page has its canonical address, Open Graph and
  Twitter tags (`web/public/og.png`), the favicon set and the web manifest.
- **Serving.** `server/src/web.ts` answers an address without an extension with `<path>/index.html` where
  the build wrote one, and with `app.html` otherwise (`index.html` in an older build); `vite preview` does
  the same. `vite` in development has no prerender: the app renders the landing itself for a signed-out
  visitor at `/`.
- **Signed in at `/`.** The landing names the app's entry module in `<meta name="wlp-app">`.
  `web/public/site.js` sees a saved sign-in, hides the page before first paint and loads the app, which
  starts from an empty root. Everyone else gets the static page, whose only script wires the theme button.
- **The content security policy.** The pages run no inline script: `theme.js` and `site.js` are files, and
  JSON-LD is a `<script type="application/ld+json">` data block, which browsers do not run and do not check
  against `script-src`.
- **Where they are published.** `VITE_WLP_SITE_URL` (build time) is the origin the pages are canonical at,
  with the default defined in `web/src/site/config.ts`. `VITE_WLP_ACCESS_URL` is where "Request access" leads (a form or
  a `mailto:` link); unset, the pages offer "Sign in" alone and say that access is by invitation.
- **Images.** `web/site-assets/og.html` is the source of `og.png` and `web/site-assets/icons.js` of the
  PNG icons and `favicon.ico`; neither is built, and each says how to make its files again.

