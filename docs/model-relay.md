# Windlass's model relay

Windlass 0.7.1 routes ChatGPT and Settings-key models through the relay. For ChatGPT, the host starts
`windlass acp` with `WINDLASS_MODEL_BASE_URL` and a `WINDLASS_ACCESS_TOKEN_FILE` that holds a
placeholder, not a ChatGPT access token. A relay outside loopback also needs
`WINDLASS_MODEL_ALLOWED_ORIGIN` set to its exact origin. Windlass sends the file's bearer on
`GET <base>/models` and `POST <base>/responses`, refuses redirects, and reads the file again before
each request.

With the relay on, a session's sandbox never holds the user's ChatGPT access token on any profile. The
token stays outside the sandbox, in a place the session's processes cannot reach. That place is the
platform server, a relay container, or the machine's relay container. Commands, setup leftovers and
approved MCP servers in the sandbox can still make model requests through the relay while a turn runs.
They cannot take a bearer elsewhere.

Without the relay, a ChatGPT turn's real access token is written into the sandbox (`token-file.ts`). The
`docker-hardened` and `e2b-open` profiles let commands read it, and setup leftovers can read it on
every profile.

## Settings keys in Windlass

A qualified picker ID selects the owner’s saved key generation before a turn starts. The platform runs `windlass acp` with `WINDLASS_PROVIDER`, the provider selection that the CLI’s `--provider` passes to ACP. The ACP session receives the provider’s native model ID, including any OpenRouter vendor prefix. Windlass pins the provider when it creates the session.

| Provider | Variable holding the turn placeholder | Relay base suffix | Paths appended for catalog and generation |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `/v1` | `/models`, `/responses` |
| Anthropic | `ANTHROPIC_API_KEY` | empty | `/v1/models`, `/v1/messages` |
| Google | `GEMINI_API_KEY` | empty | `/v1beta/models`, `/v1beta/models/<model>:streamGenerateContent?alt=sse` |
| OpenRouter | `OPENROUTER_API_KEY` | `/api/v1` | `/models`, `/chat/completions` |

E2B adds the suffix to the relay origin and `/model-relay`. Docker and paired machines add it to the loopback forwarder origin. Catalog pagination and automatic titles use the same lease. The platform checks the machine pairing and proof for forwarded requests. Only the platform relay resolves the saved key. Removing or replacing the key invalidates its generation. Stopping the turn revokes its lease. Hosted leases share the configured per-turn request cap across server processes.

Reported requests are receipted against the selected provider and key generation. The daily ChatGPT allowance applies to unprefixed models. A missing Settings key, an unavailable key relay or a sandbox running Windlass before 0.7.1 refuses a key-backed turn.

## Where the relay runs

| Place | Relay | How the sandbox reaches it | Base URL Windlass gets |
| --- | --- | --- | --- |
| Hosted Docker | One relay container per Docker daemon, `wlp-model-relay` | A forwarder container in the session container's network namespace (`--network container:<session>`) listens on `127.0.0.1:17893`. It connects to the relay's Unix socket, writes the turn's 32-character nonce, then pipes the bytes. | `http://127.0.0.1:17893/v1` |
| A user's machine (runner) | One relay container per machine, `wlp-model-relay-<machine id>`, made by the runner | As hosted Docker, with the runner's helpers | `http://127.0.0.1:17893/v1` |
| Hosted E2B | The platform server itself: `POST /model-relay/v1/responses` and `GET /model-relay/v1/models` on `WLP_MODEL_RELAY_URL`, a hostname of the relay's own | Over the internet. In `restricted` and `none` E2B allows that hostname in place of `api.openai.com`, and never the platform's public host | `<WLP_MODEL_RELAY_URL>/model-relay/v1`, with `WINDLASS_MODEL_ALLOWED_ORIGIN=<WLP_MODEL_RELAY_URL>` |

### Settings keys

Resolve the turn’s provider from the model and the owner’s current key generations.
A caller opens a key-backed turn with `openModelKeyRelay(sandbox, sessionId, { provider, generation, harness }, signal)`
in `sandbox/token-file.ts`. Start the client with the returned base URL and placeholder in the provider's
usual credential header or as a Bearer token. Close the lease when the turn ends. Opening fails if the sandbox
has no key relay. The ChatGPT access-token file fallback is specific to ChatGPT.

The platform lease holds the harness, provider and generation saved by the user actor. For each admitted
request the platform relay calls B1's `internalModelKey` as `model-key/<uid>` with a fresh nonce,
opens the 60-second transit blob, and checks the generation before sending the request.
Removing or replacing the key blocks the next request on every lease of the old generation.

The paths below are relative to `/model-relay` on the platform and the loopback origin on Docker.
The client base ends in `/v1` for OpenAI and `/api/v1` for OpenRouter. Anthropic and Gemini use
the relay root and append their own API version.

| Lease | GET | POST | Upstream credential |
| --- | --- | --- | --- |
| ChatGPT | `/v1/models` | `/v1/responses` | Bearer at `api.openai.com` |
| OpenAI | `/v1/models` | `/v1/responses`, `/v1/chat/completions` | Bearer at `api.openai.com` |
| Anthropic | `/v1/models` | `/v1/messages` | `x-api-key` at `api.anthropic.com`, version `2023-06-01` |
| Claude plan | `/v1/models` | `/v1/messages` | Bearer (the `claude setup-token` token) at `api.anthropic.com`, version `2023-06-01`, Claude Code only |
| ChatGPT plan | `/v1/models?client_version=…` (Codex's own catalog request) | `/v1/responses` | Bearer (the plan's current access token) at `api.openai.com`, Codex and Windlass only |
| Google | `/v1beta/models` | `/v1beta/models/{model}:generateContent`, `:streamGenerateContent` | `x-goog-api-key` at `generativelanguage.googleapis.com` |
| OpenRouter | `/api/v1/models` | `/api/v1/chat/completions` | Bearer at `openrouter.ai` |

Gemini streaming accepts `?alt=sse`. Anthropic Messages accepts the `interleaved-thinking-2025-05-14`
beta. A Claude plan lease uses its own wire, `claude-plan` (`credentialWire` in `sandbox/relay/wires.cjs`):
Claude Code sends its placeholder from `CLAUDE_CODE_OAUTH_TOKEN` as a bearer, and the route sends the plan's
token as a bearer with the `oauth-2025-04-20` beta allowed. Hosted Docker forwards it with `provider: "claude-plan"`.
A ChatGPT plan lease uses the `chatgpt-plan` wire: the `chatgpt` wire's routes and headers, with Codex's
compressed bodies allowed. Codex sends its placeholder as a bearer (below); the route asks the user's actor for the
plan's current access token at every request (`ChatgptPlan.token`, `server/src/actors/user/signin.ts`), so a token
the sign-in holder refreshed is the next request's. codex-acp's bare `GET /v1/models` is refused: it narrows its list
by a `data[]` that ChatGPT's catalog (`models[]`) may not have, and a refusal leaves Codex's list as it is.
On E2B and Daytona a plan's requests do not go through the route: they leave from the sandbox
([Plan requests from the sandbox](#plan-requests-from-the-sandbox)). Machines refuse a plan for now. Each route selects its upstream and permitted headers from the lease. Caller-supplied OpenRouter
attribution, credentials in query strings, and redirects are refused.

Hosted Docker and paired machines forward key-backed requests to `WLP_MODEL_RELAY_URL`, which must
be configured and reachable from the relay container. The container holds a second placeholder for
the platform lease in its private tmpfs. Its sandbox gets only the local placeholder tied to the forwarder.
A paired machine signs each forwarded request with a per-turn key delivered over its session connection.
The platform verifies the signature for that machine and path. The forwarding lease expires one minute
after the turn timeout. The runner never receives the provider key.

The Docker relay is the program `sandbox/relay/windlass.cjs`, on the shared `createRelay` of
`sandbox/relay/server.cjs`, the same one the Claude Code, Codex and OpenCode relays of machines use. It
runs from the pinned base image as `agent`, read-only, with every capability dropped, rotated Docker logs on machines,
192 MiB (`RELAY_MEMORY`) and 48 processes. The Docker check runs 64 streams at once through it, each with a
1 MiB request body and a 2 MiB answer, and fails if the relay comes near that memory. Its only network is the Docker bridge, which reaches
OpenAI for ChatGPT leases and the platform relay for Settings keys. The forwarder is `wlp-model-forward` in `runner/src/egress-proxy.mjs`, beside
the machine's other forwarders. Only the relay and the forwarders mount the socket volume
(`wlp-model-socket[-<machine id>]`), and the forwarders mount it read-only.

One hosted server per Docker daemon. The relay container, its socket volume and the forwarders
(`wlp-model-fwd-<sandbox>`) are named per daemon, not per deployment, and a starting server removes every
hosted forwarder it does not hold a lease for, with the relay's token files. A second platform server on
the same daemon (a test server beside a live one) would remove the first one's forwarders and share its
relay, cutting its turns' model requests. Give each server its own Docker daemon, or run the second with
`WLP_MODEL_RELAY=off` or on the fake layer. Runner relays are per machine and are not affected.

E2B's microVMs reach the platform only over the internet, so there is no namespace to put a forwarder
in, and the relay is a route of the server. The server also holds the sign-in, so the token never
leaves it.

The route has a hostname of its own, `WLP_MODEL_RELAY_URL` (for example
`https://windlass-relay.example.com`), routed to the same server as `WLP_PUBLIC_URL`. When a request's
`Host` is that name, the server answers the relay's model routes and refuses everything else with a 404. No
other host serves the relay's paths. So E2B's allow list opens only the relay to a sandbox, and not the
web app, the API or the runner routes. Without `WLP_MODEL_RELAY_URL`, E2B turns get today's token file,
the server says so once at startup, and the platform's public host is never allowed in its place.

The operator routes the name to the server. With the self-hosted Cloudflare Tunnel, add an ingress rule
for the hostname before the final `http_status:404` rule, pointing at the same loopback port as the web
app's hostname, and route the DNS name to the tunnel ([deploy/selfhost/README.md](../deploy/selfhost/README.md#the-model-relays-hostname)).
Elsewhere, point a DNS name at whatever serves `WLP_PUBLIC_URL`, with a certificate for it, and keep the
`Host` header as the client sent it.

### Plan requests from the sandbox

Through the route, every user's plan requests would reach the provider from the platform server's one address.
E2B and Daytona sandboxes have addresses of their own, so there a plan turn runs the relay inside the
sandbox (`server/src/sandbox/plan-relay.ts`, the program `sandbox/relay/plan.cjs` on the shared `createRelay`
and the plan's wire, `claude-plan` or `chatgpt-plan`). Hosted Docker sandboxes share the server's address and keep the route.

- **Who runs it.** The transport user (`nobody`, the user Git transport and its GitHub tokens run as), never
  `agent`. The agent has no sudo, so it cannot read that process's memory, standard input or `/proc` files, nor
  signal it. Node is `/usr/local/bin/node` of the image; no template rebuild is needed.
- **What it gets.** At the turn's start the session opens the plan's token through the user actor
  (`internalCredential`, `openSavedCredential` in `server/src/credentials/transit.ts`) and checks the turn's pinned
  generation. The relay's source and then `{token, placeholder, expiresAt, wire, harness}` go to its standard
  input, one JSON line each. Nothing is written to the sandbox's disk and nothing secret is on a command line or in an
  environment. Stdin stays open as the control channel: a later `{token}` replaces the token (requests that start
  after it carry the new one, running ones keep theirs), and the relay asks the platform to count each request
  against the turn's limit (`{take}`/`{took}`). Stdin closing ends it.
- **A ChatGPT plan's token expires.** It is opened with at least 20 minutes left (the sign-in holder's promise),
  and when 10 are left the turn asks the user's actor for the current one, which the holder refreshes, and hands
  it over stdin (`rotatePlanToken` in `server/src/sandbox/token-file.ts`, `TokenFile`'s schedule). A failed try
  is tried again every 20 s. A plan reconnected or removed meanwhile gives no token: the relay keeps the one it
  has until it expires. The refresh token never leaves the user's actor.
- **What it accepts.** It listens on `127.0.0.1` on a port the kernel picks. It accepts only
  `Authorization: Bearer <placeholder>`, a fresh `wlp-plan.` placeholder for each turn, and only the turn's agent's
  routes on the plan's wire with that wire's headers (and betas). It sends them to the wire's host
  (`https://api.anthropic.com`, `https://api.openai.com`) with the real bearer and removes every token it was handed
  from every answer. On a Claude plan it answers `HEAD /api/hello` itself. An upstream error,
  a 401 included, keeps its status with the provider's scrubbed error code, type and message. Claude Code gets
  `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and `CLAUDE_CODE_OAUTH_TOKEN=<placeholder>`; Codex gets `WLP_CODEX_BASE_URL=http://127.0.0.1:<port>/v1`
  and `WLP_SESSION_BEARER=<placeholder>`. The placeholder is redacted from the turn like a key lease's.
- **Lifetime.** The relay starts with the turn and is stopped (stdin closed, then its process group killed) when
  the turn ends or is aborted, so a paused or snapshotted sandbox keeps no token. If it cannot start or listen,
  the turn fails; the token is never put in the sandbox instead. A relay whose server died mid-turn stops itself
  at the turn's limit plus a minute, by the wall clock.
- **Revocation is per turn.** The route checks the plan's generation at every request. This relay checks it once,
  at the turn's start. A reconnected or removed plan, or `WLP_PLAN_USERS` turned off, takes effect at the next
  turn, not mid-turn.
- **E2B network.** Out of `open`, a Claude Code sandbox (its `wlp_harness` metadata) may also reach
  `api.anthropic.com`, and a Codex sandbox `api.openai.com`, at create and at every connect (`withPlanHosts` in
  `server/src/sandbox/e2b/network.ts`), whether or not its owner has a plan. Other agents' sandboxes may not. The relay's host stays allowed: Settings keys still use the route. Daytona runs open only.

Anything that can run as the transport user can read the token while a turn runs, as it can a GitHub token
during a push. On E2B that rests on the agent having no sudo and on envd's API not running commands for
processes inside the sandbox; on Daytona, on the launcher's sudo rule and the toolbox not being reachable by
the agent.

## The placeholder

Each turn gets a lease of its own when its token file is first written, and the lease ends when the turn
ends.

- **Docker and machines.** The lease is a random 32-character nonce and a random 32-character secret.
  The placeholder in the sandbox's token file is `wlp-model.<secret>`. The nonce is a forwarder argument,
  outside every mount namespace the session has. The relay accepts a request only when its connection
  came through that turn's forwarder (the nonce) and its bearer is that turn's placeholder. Another
  session's placeholder is refused on this session's connection, and a placeholder taken out of the
  container is of no use without the forwarder. When the turn ends, the relay forgets the lease and the
  forwarder is removed. The forwarder writes that it holds `127.0.0.1:17893` into a tmpfs of its own,
  which the session cannot reach. If a process of the session took that port first, the forwarder exits.
  The turn then fails with "the model relay's forwarder ... a process in the sandbox may be holding that
  port", and nothing is handed to it.
- **E2B.** The placeholder is signed by the server (`signatures.ts`, purpose `model-relay`). It names the
  user, the session and the turn's nonce. Its signature counts for the longest turn plus 15 minutes
  (`WLP_TURN_TIMEOUT_MS` + 15 min, `E2bProvider.relayLeaseMs`), not for the token's hour. The file
  beside it states the token's expiry, which Windlass checks. The lease itself ends with the turn, well
  before the signature does. The route checks the signature and the expiry, then asks the turn's live
  lease for the token. This is a lookup in the server's process, or in the session's actor
  (`internalModelRelay`) when another server process took the request. A lease that ended (the turn is
  over) is refused, whatever its signature says. Its nonce is then remembered as ended until the
  signature expires, so a placeholder of a finished turn that keeps being sent costs no actor call. The
  placeholder works from anywhere on the internet while the turn runs, but only for model requests at
  this relay, under the caps below.

The placeholder file has the same form as a handed-in token, `{"accessToken": "<placeholder>",
"expiresAt": <ms>}`, with the expiry of the ChatGPT token behind it. Windlass then refuses an expired
placeholder before it sends anything, and the platform's existing failures (`handed_in_expired`,
`handedInFailure`) keep their meaning.

## Refresh and rotation

The token's schedule is unchanged (`token-file.ts`). The turn's `TokenFile` gets a token good for at
least 20 more minutes, and replaces it when 10 minutes are left. With the relay, each new token goes to
the relay first, and then the placeholder file is rewritten with the new expiry. The lease stays the same.

- On Docker and machines, the token is written into the relay container's private tmpfs
  (`/run/wlp-model/tokens/<nonce>.json`, mode 0600). This uses `docker exec` with the content on
  standard input, as `writeSecretFile` does. The relay reads that file on every request, so a request
  that starts after a replacement uses the new token. A request already streaming keeps the token it
  started with.
- A ChatGPT plan lease (hosted Codex) holds no token: the route asks the user's actor per request, and the
  holder answers the token it keeps while it has more than 20 minutes left, else refreshes once for everyone
  asking. A relay inside an E2B or Daytona sandbox is handed a new one on the schedule above.
- On E2B, the turn's lease holds the current token in memory. The route reads it on every request,
  cached for at most 5 seconds when it came from another process. The session actor seals that
  ChatGPT token for the requesting relay, bound to user, session, lease and request nonce. The transit
  blob expires after 60 seconds.

### When the lease ends

`close` ends the turn's requests still running, on both relays, not only the next ones:

- On Docker and machines, `close` removes the turn's file first, then the forwarder. The relay looks at
  the leases of its running requests when its token directory changes and once a second, and stops every
  request of a lease whose file is gone or whose token has expired.
- On E2B, `close` aborts the lease's requests in the process that holds it. A request that another server
  process carries is looked at every 5 seconds and aborted once the session's actor says the lease is
  gone.

A request that waited for a slot while its turn ended is answered 401 when its turn's token is looked up
again. It is never sent with the token it was first looked up with.

### What a stopped process leaves

A lease is held by the process that opened it. When the hosted server starts, and when a runner gets its
first welcome, it removes every forwarder of its scope (labelled `windlass-platform.model-relay=forward`)
and every file in its relay's token store, because none of their leases can still be live. This assumes
one server process per Docker daemon, as hosted Docker has (`WLP_ALLOW_DOCKER_HOSTED`), and one runner
per machine. The relay itself deletes, once a minute, every file whose `expiresAt` has passed or that is
no record. On the hosted server and on a runner, suspending or removing a sandbox ends its lease too: its
file in the relay, its forwarder, and on a runner the conversation's `relays` entry.

Only the user's actor ever refreshes, as before. No relay holds a refresh token.

## Limits

They are the relay caps of machines (`sandbox/relay/server.cjs` `limits`): 8 requests in flight and 32
waiting per session (turn), and the relay's whole in-flight ceiling, with a FIFO wait of up to 90 seconds
before a 503 with `retry-after`. A session's connections past 32 are refused. The ceiling for the whole
relay is 24 on a machine, which serves one user. A hosted relay serves every user of the deployment, so
it uses `WLP_MODEL_RELAY_REQUESTS` (default 64), and 16 in flight per user (`HOSTED_RELAY_USER_REQUESTS`,
counted by the user each turn's file names). The E2B route applies the same per-turn numbers, the same
deployment ceiling and 16 in flight per user. Key-backed turns on every backend go through this route,
so the platform's 16 in-flight requests per user is the effective per-user limit. It also has:

- 300 requests a minute per user, after a burst of 100, counted from the placeholder's signed user before
  any lookup. Past it the answer is a 503 with `retry-after`.
- request bodies counted as they are read, with a 413 past 32 MiB, and 256 MiB of request bodies in
  flight across all requests. Past that, a 503 with `retry-after`. The body is then sent upstream whole,
  with its `content-length`, the way Windlass sends it to `api.openai.com` itself. The server's HTTP
  listener (RivetKit's) already holds the whole body before the route runs, so streaming it on saved no
  memory. The request goes out with `node:https`, not fetch, carrying only Windlass's own headers
  (`content-type`, `accept`, `session-id`, `user-agent`, and its `accept-encoding` of gzip, deflate, br and
  zstd, which the route decodes itself), so it has none of fetch's `sec-fetch-mode` or `accept-language`.
  A 200 to `POST /responses` with no content type, or `text/plain`, is passed on as an event stream,
  because Windlass reads that answer as one whatever its type says. Any other type is a 502.

  The server logs failed status codes, elapsed time and fixed upstream diagnostics. The log limit is
  60 lines a minute. Provider text, request IDs and user-supplied paths stay out of diagnostics.

The E2B route's limits are those of one server process. A deployment of several processes has each limit
once per process, so its real ceilings are that many times higher. The per-user limits bound how many
requests a user has in flight, not what they spend: a user's turns can still use the plan's whole quota
through the relay while they run.

The ChatGPT lease accepts only `GET /v1/models` and `POST /v1/responses`, with `Host: 127.0.0.1:17893` on
Docker. It sends them to `https://api.openai.com/v1/...` with the real bearer, and passes on only
`content-type`, `accept`, `session-id` and `user-agent`. A redirect is a 502. Every token the relay
has used is removed from the response stream. An error reply keeps the provider's `error.code`,
`error.type` and a scrubbed, shortened message, so Windlass still tells a usage limit, a rate limit and a
context overflow apart. Nothing that names the account or the request is passed on.

The relay's own 401s (no live lease for the placeholder) carry `error.code: "relay_lease_ended"`.
Windlass reports any 401 of a handed-in token as `handed_in_rejected`, with the provider's code in its
message. The platform maps a `relay_lease_ended` there to `token_unavailable` ("send the prompt again",
`handoff.ts` `relayRefused`). The user is not told to sign in again for a refusal that is the relay's.

## Rollout, and what happens when the relay is unavailable

| Where | When the relay is used | Otherwise |
| --- | --- | --- |
| Hosted Docker | `WLP_MODEL_RELAY` is not `off` (default on), and the sandbox image's Windlass, as `windlass.problem()` reads it, is 0.6.0 or later | today's token file, and the server says so at startup |
| Machines | the server names `model-relay` in its welcome, and the runner says `modelRelay` in its report and its `connect` answer. ChatGPT requires Windlass 0.6.0 or later. Settings keys require Windlass 0.7.1 and a runner that negotiates `windlass-key-relay`. | today's token file, as on those runners now |
| Hosted E2B | `WLP_MODEL_RELAY` is not `off`, `WLP_MODEL_RELAY_URL` is set, and `WLP_E2B_WINDLASS_VERSION` is 0.6.0 or later | today's token file, and the server says which of these is missing at startup |

The token-file fallback above applies only to ChatGPT. Windlass 0.7.x sessions cannot be opened by 0.6.0. While the relay is on for E2B, `api.openai.com`
is not in E2B's allow list: the sandbox has no token it would take.

Each profile says per sandbox which applies. A profile with the relay has `modelRelay: true`, and its
summary is written from both flags. `commandsCanReadAccessToken` keeps its meaning, "can read the token
file". With the relay that file holds only a placeholder, and the summary says: "Commands can read only a
placeholder for this turn. With it they can make model requests on your ChatGPT plan through the relay
while the turn runs (8 at once, 32 waiting). The access token never enters the container" (or microVM).

**Fail closed.** Once a turn is to use the relay, it never falls back to handing the real token to the
sandbox. If the relay cannot be started or reached, or it refuses the token, the turn fails with "the
engine could not be started in the sandbox: the model relay could not be started: …", and nothing is
written into the sandbox. A quiet fallback would make what the side panel says depend on a race, and a
failed turn can be tried again. The fallbacks in the table are decided before the turn, from what the
deployment and the runner say, and the panel shows which one applies.

Turns that are already running keep the mode they started with.

To roll out 0.7.1, rebuild the Docker image with `sandbox/build.sh` and publish the sandbox and runner images through the image release workflow. The runner bundles its local relay. Build each deployed Windlass template with `sandbox/e2b/build.sh` and its matching `WLP_E2B_SIZE` and `WLP_SANDBOX_VARIANT`. Point the servers at the new templates and set `WLP_E2B_WINDLASS_VERSION=0.7.1`.

## Checks

- `scripts/windlass-key-docker-check.ts` runs the released ACP binary against four fake providers on an isolated loopback network. It checks model listing, generation, key refusal and the live sandbox environment and files.

- `scripts/windlass-relay-check.mjs` (in `pnpm test`): the relay program with a recording upstream.
  It covers bearer replacement, another session's placeholder on this connection, an ended lease, a token
  replaced while a request streams, caps and waiting, the ceiling per user, error codes kept, the relay's
  own `relay_lease_ended`, a lease's end stopping its running requests, expired files deleted, tokens
  removed from responses, and only the two routes.
- `scripts/plan-relay-check.ts` (CI heavy `rules`): the in-sandbox plan relay as a local process with a recording
  upstream: bearer swapped, another placeholder, host or route refused, `HEAD /api/hello` answered locally, the
  token scrubbed from streams and error bodies, a 401 kept, a replaced token used next, the turn's request limit,
  close, abort and expiry, and no start without a token on stdin. `scripts/e2b-provider-test.ts` ("a plan's relay
  in the sandbox") and `scripts/daytona-provider-test.ts` cover how each provider starts and stops it and the E2B
  allow list.
- `scripts/model-relay-route-check.ts` (CI heavy `rules`): the E2B route, with signed, expired, forged and
  ended leases, refresh, caps, a queued request whose turn ended, bodies sent whole and capped, the rate per
  user, ended leases remembered, `close` aborting running requests here and in another process, the
  relay's own hostname, the version gates, the E2B network with the relay's host and without
  `api.openai.com`, an E2B sandbox with no session, and the mapping of the relay's refusals.
- `scripts/model-relay-e2b-check.ts` (by hand: it needs an E2B key and a real access token): one real
  model request from an E2B sandbox through a relay hostname to `api.openai.com`. It starts the server in
  its own process on ports and storage of its own, behind a Cloudflare quick tunnel, makes one sandbox under
  `restricted`, and runs one real turn through the platform's turn code: "Reply with exactly: relay ok".
  It checks the answer, that the model call reached `api.openai.com` and was answered, that the relay
  logged no failure, and that the token is nowhere in the sandbox. Nothing in CI makes a real model
  request, so run it before turning the relay on for E2B and after changing the route.
- `scripts/model-relay-docker-check.ts` (CI heavy `sandbox-docker`): the hosted relay with real
  containers. It repeats the experiments of the token-exposure note in a hardened session container: a
  scan of the files, of `/proc/*/environ` and `/dev/shm`, and a process left over from setup. The real
  token is nowhere in the container. It also runs `windlass --models` through the relay, replaces the
  token while requests run, applies the caps, and shows that the forwarder is gone after the turn. It
  also stops a streaming request at the turn's end, fails a turn whose port a session process holds,
  removes what a stopped server left, and runs the 64-stream memory test.

## Hosted ACP agents

Claude Code uses Anthropic. Codex can list OpenAI models and call Responses. On a ChatGPT plan (where
`WLP_PLAN_USERS` allows; the plan pays before an OpenAI key) Codex gets the same environment as on a key:
`wlp-codex-acp` hands codex-acp a custom provider (`providers/set`: base URL `WLP_CODEX_BASE_URL`, the placeholder
`WLP_SESSION_BEARER` as its bearer, `wire_api = "responses"`), and no `auth.json` is written; `wlp-codex-app-server`
refuses to start Codex if one is in `CODEX_HOME`. Its models are the plan's, from ChatGPT's catalog. OpenCode receives only the provider for its selected model. Before OpenCode has reported a catalog, its default uses the first saved provider in this order: OpenAI, Anthropic, Google, OpenRouter. The adapter chooses a model from that provider. Each turn pins one key generation before provisioning. Reported tokens are attributed to that provider. Cancellation revokes the platform lease immediately, including while the Docker forwarder is starting.

On hosted Docker the guest receives a local bearer. A separate forwarder listens on loopback in that container’s network namespace and prefixes its connections to the relay socket with the turn’s nonce. The relay matches both nonce and bearer. A different container’s forwarder supplies a different nonce. Only the relay and the forwarders mount the socket volume. The platform placeholder stays in the relay’s private tmpfs.

On E2B the guest receives the platform placeholder directly. Anyone who copies it can use it from outside the microVM and spend the owner’s quota until the turn ends. The lease is bound to the owner, session, turn, one provider generation and the harness’s allowed routes. Its signature expires after at most the configured turn timeout. The session’s lease owner enforces a shared per-turn cap of 300 requests by default (`WLP_MODEL_RELAY_TURN_REQUESTS`), including requests received by another platform process. Each accepted request can still consume provider tokens.

Set `WLP_MODEL_RELAY_URL` to the dedicated relay hostname. E2B also requires `WLP_E2B_OPEN_PROFILE=1` and the template’s Windlass version as described above. Agent commands run directly as the guest’s non-root user.

Build one image per agent from the normal base sandbox image. Hosted Docker defaults to the local tags produced by these commands. Set `WLP_CLAUDE_IMAGE`, `WLP_CODEX_IMAGE` or `WLP_OPENCODE_IMAGE` to use a preloaded image by digest.

```sh
sandbox/build.sh
for agent in claude codex opencode; do
  sandbox/harness/build.sh "$agent"
done
```

Approximate local disk sizes reported by `docker image ls` for cached arm64 images are 1.48 GB for the shared base, 2.12 GB each for Claude Code and Codex, and 1.77 GB for OpenCode. The additions are about 640, 640 and 290 MB respectively. Docker shares the base layers. E2B uses amd64 and its snapshot sizes may differ.

For E2B, publish the corresponding amd64 harness image through the normal image release. Point the builder at its immutable registry reference. For example, with `CLAUDE_IMAGE_DIGEST` set to that image's full reference, inspect the small template locally:

```sh
WLP_E2B_HARNESS=claude WLP_E2B_HARNESS_IMAGE="$CLAUDE_IMAGE_DIGEST" sandbox/e2b/build.sh --print
```

To build, set `E2B_API_KEY` and omit `--print`. Repeat for codex and opencode and for each offered `WLP_E2B_SIZE`. Templates use that size's configured base template name with `-claude`, `-codex` or `-opencode` appended. ACP sessions use these templates directly and skip Windlass setup snapshots.
