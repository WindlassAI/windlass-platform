# Claude credential relay

The runner loads this program into a separate container from its pinned base image.
New session containers have no login mount. The relay and trusted login helpers
mount the pairing's login volume. A stopped legacy container retains its original
Docker mount until the owner archives its workspace and removes the container.
The runner signs a random 128-bit nonce with the pairing's Ed25519 key. The signed
message begins with `windlass-claude-relay-v2` and includes the machine ID. The
relay receives the public key. At creation the runner stores the nonce in an immutable
Docker label and configures a trusted helper in the session’s network namespace.
The helper listens on `127.0.0.1:17892`. It connects to the pairing’s Unix socket,
writes its fixed 32-character nonce, then pipes the agent’s bytes. Only the relay and
trusted Claude helpers mount this socket volume. The relay checks the signed bearer
against the connection’s nonce on every request before reading the setup token.
Suspension removes the helper. Resume restores it using the label. A replacement
session gets a fresh nonce even when it binds the same loopback port.

The relay listens only on the Unix socket. Its Docker bridge carries outbound TLS
to `api.anthropic.com:443`. The only accepted operations are POST to
`/v1/messages` and `/v1/messages/count_tokens`, optionally with `?beta=true`.
Successful JSON and SSE responses stream with backpressure. An upstream failure
returns a generic diagnostic and its HTTP error status. A redirect returns 502.
The relay disables Docker log capture and supplies all destination and auth fields
itself.

## Pinned client verification

The arm64 Claude Code binary in `sandbox/harness/claude/Dockerfile` has SHA-256
`307f8bada27b37db7553fac75e86004e3dbff5a931ffc611b54fe710ce1eb521`. It reported
2.1.328. The ACP adapter reported 0.109.0, and the lockfile pins its Agent SDK
to 0.3.328. Inside the adapter package, `dist/v1/acp-agent.js:7591` builds the
query environment from the process environment. In `dist/providers.js:42`,
`createEnvForProvider` supplies no overrides for a native session.

The following byte offsets refer to that arm64 binary.

| Offset | Pinned behavior |
| --- | --- |
| `0x1264a887`, `0x1264a7a0` | The CLI accepts the environment token as an access token and constructs credentials with null expiry and refresh token. |
| `0x1261655d`, `0x122caf96` | The OAuth path builds a Bearer header and selects the OAuth beta constant. |
| `0x128d8fb7` | The Messages client posts to `/v1/messages?beta=true`. |
| `0x12604a6c`, `0x12c797ab` | Other CLI paths contain `/api/oauth/profile` and `/api/oauth/usage`. Profile uses the OAuth API origin. |
| `0x122cb26c` | Production OAuth configuration names `api.anthropic.com`, `claude.ai`, the browser authorization endpoint under `claude.com`, and the token endpoint `https://platform.claude.com/v1/oauth/token`. |

A disposable container with external networking disabled ran the pinned client,
a loopback relay, a recording upstream and a DNS recorder. A control lookup
verified DNS capture. ACP completed `initialize`, `session/options`, `session/new`,
`session/set_mode` and `session/prompt`. The turn sent **two POSTs to
`/v1/messages?beta=true`**. Each used the arbitrary non-OAuth-shaped placeholder
as a Bearer, omitted `x-api-key`, and supplied `anthropic-version: 2023-06-01`
and beta flags including `claude-code-20250219` and `oauth-2025-04-20`.
Both requests also supplied `interleaved-thinking-2025-05-14`,
`context-management-2025-06-27`, `per-turn-control-2026-07-01`,
`mid-conversation-tool-changes-2026-07-01`, `thinking-token-count-2026-05-13`,
and `effort-2025-11-24`. One added `structured-outputs-2025-12-15`. The other
added `advanced-tool-use-2025-11-20`, `dangerous-tool-use-2026-09-03`,
`thinking-display-updates-2026-08-18`, `afk-mode-2026-01-31`, and
`extended-cache-ttl-2025-04-11`. The relay forwards the client's beta header.
The upstream verified the replacement bearer and the client emitted the
expected SSE text and ACP `end_turn`.

The trace contained zero external DNS queries from the client and zero profile,
usage, refresh, or browser calls. This covers the tested startup and turn.
Account-specific behavior, error recovery against Anthropic, and acceptance of
an actual subscription token require a real-account check.

## Running the checks

`pnpm test` includes the offline protocol cases. For the Docker proof, pass a
local immutable image ID built with the updated Claude wrapper. From `server/` run

```sh
pnpm exec tsx ../scripts/claude-relay-docker-check.mjs sha256:<local-Claude-image-ID>
```

The Docker proof uses the normal runner create, login, connect, and destroy paths.
A test CLI maps session and credential resources into unique fixture names and
routes the relay's uplink to an internal TLS recorder under the pinned DNS name.
Only the relay adds the recorder’s test CA to its client trust store. The real ACP
adapter completes streamed turns with the restricted proxy configured and with an unreachable proxy. Two Claude
sessions have only loopback, and each refuses the other’s bearer. The check also
covers resume, replacement, logout, legacy mounts, and the model route in open
and none modes.

## Failure controls

The original mounted wrapper replaced the placeholder from the login file, and its
readability check failed. The relay protocol tests exercise bearer replacement,
streaming before upstream EOF, foreign Host rejection, signature and session checks,
logout, and redirect sanitization. A pipelined request carrying a different session’s
signed bearer must receive HTTP 401 on the same connection. The Docker test also
requires logout to delete the token when a foreign container occupies the relay name.

## Deployment assumptions

The runner trusts the Docker daemon, its pinned helper image, and the pairing key.
Keep the login and socket volumes private to their designated containers. Restricted
and none use Docker’s `none` network. Open uses the pairing bridge with inter-container
communication disabled. The wrapper includes loopback in both forms of `NO_PROXY`.
The relay needs outbound HTTPS to Anthropic in all modes. A command in a Claude
session can call that session’s model API and consume quota. See [docs/machines.md](../../docs/machines.md#claude-code-on-this-machine)
for the upgrade and credential rotation steps.
