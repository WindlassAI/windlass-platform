# Windlass Platform

A hosted home for [Windlass](https://github.com/parthg1901/windlass), the terminal coding agent: sign in with
ChatGPT, launch agents, choose the sandbox each one works in, and watch every turn live in the browser.

It is built on [Rivet Actors](https://www.rivet.dev/actors/docs). Each agent session is one actor that owns the
conversation and drives a Windlass process inside a sandbox.

![A session: the agent's tool calls, its answer, and the session panel](docs/screenshots/session.png)

![The agent asks before a command gets network access](docs/screenshots/question.png)

## Run it

You need Node 22 or later, pnpm, Docker, and a Windlass executable for Linux that can hand its sign-in's access
token to another Windlass and be asked for one that is good for a while yet: one with
`windlass login token --valid-for <duration>` and `WINDLASS_ACCESS_TOKEN_FILE` (`windlass login --help` lists
`--valid-for` under `login token`). The version number does not tell: both the builds that have the option and
the ones before it call themselves 0.1.1. Until a release has it, that is a local build of Windlass with the
option (`windlass --version` prints `0.1.1+739e1cbc09` for the one this was tested with, which also names every
failure of a sign-in by a stable code; `0.1.1+dca57b2627` has `login token` without `--valid-for` and is too
old).

```sh
pnpm install

# Build the sandbox image. Without WINDLASS_BINARY it takes the local build that has all of this,
# ~/projects/windlass-local-builds/windlass-linux-<arch>, when that exists.
WINDLASS_BINARY=/path/to/windlass-linux-arm64 sandbox/build.sh

scripts/dev.sh                              # the server: Rivet endpoint on http://localhost:6420, demo sign-in on
pnpm --filter @windlass-platform/web dev    # the web app on http://localhost:5173
```

Open http://localhost:5173. "Try the demo" needs no account: it runs Windlass's real engine and real tool calls in
a real container, with a scripted model in place of ChatGPT. "Continue with ChatGPT" runs on your own plan.

With an older Windlass in the image the demo still works and nothing else does. There are two kinds: one without
`windlass login token`, and one that has the command but not its `--valid-for` option. `sandbox/build.sh` warns
about either, the server says so when it starts (`[wlp] WARNING: The Windlass in the sandbox image ... has no
windlass login token ...`, or `... has windlass login token but not its --valid-for option ...`), and a turn on a
ChatGPT sign-in ends with the same sentence. The remedy is always to rebuild the image from a newer Windlass and
start the server again.

When the browser is on another machine, forward ports 5173 and 6420, or set `VITE_WLP_ENDPOINT` (web) and
`WLP_WEB_ORIGINS` (server) to the addresses you use.

Without Docker, `WLP_SANDBOX=fake scripts/dev.sh` runs in-memory sandboxes that replay recorded Windlass runs, and
`VITE_WLP_MOCK=1 pnpm --filter @windlass-platform/web dev` runs the web app with no server at all.

## How it fits together

```
browser ── WebSocket ──▶ Rivet endpoint (:6420)
                           │
                           ├─ platform      ["main"]            what this deployment offers
                           ├─ login         [attemptId]         one sign-in attempt
                           ├─ user          [uid]               profile, the index of sessions
                           └─ agentSession  [uid, sessionId]    timeline in SQLite, one sandbox
                                               │
                                               ▼
                                   Docker container  wlp-session-<id>
                                     /workspace                        the agent's files
                                     ~/.local/share/windlass           volume wlp-user-<uid>: Windlass's own
                                                                       session logs and memory, and the turn's
                                                                       access token file. No sign-in
                                     windlass acp                      one process per turn

                                   volume wlp-auth-<uid>               the user's ChatGPT sign-in; mounted only into
                                                                       short-lived helper containers
```

- **A turn.** `agentSession.prompt()` returns at once. The actor starts or creates its sandbox and starts
  `windlass acp` in it for this one turn, speaking the Agent Client Protocol over `docker exec`. Every durable
  event goes into the actor's SQLite timeline and streaming output is broadcast to connected browsers. The turn is
  held with `c.keepAwake`, so the actor does not sleep under it. A follow-up prompt resumes the same Windlass
  session.
- **Questions, steering, stopping one call.** When a tool call needs approval (in the Windlass-sandbox profile: a
  command that asks for the network, or to write outside the workspace), Windlass asks, the session's status
  becomes `waiting`, and the browser shows the question with its choices: allow once, allow for the session, or
  decline with a note for the agent. A question nobody answers in ten minutes is declined by the platform. A
  message sent while a turn runs steers it: the model reads it at its next step. One running tool call can be
  stopped without ending the turn.
- **Sleep.** With no browser connected and no turn running, the actor sleeps after 30 seconds and stops its
  container. The next prompt, or opening the session, starts it again with its files intact.
- **Sign-in.** Windlass does it itself. `login.start()` runs `windlass login start` in a throwaway container and
  returns the OpenAI address. The browser ends on `http://127.0.0.1:1455/auth/callback`, which does not load; the
  user pastes that address, and `login.finish()` feeds it to `windlass login finish`. The saved sign-in is moved
  into the user's auth volume, `wlp-auth-<uid>`. The platform's own token is an HMAC-signed string, checked in
  `onBeforeConnect` and again in every action.
- **No sandbox holds the sign-in.** The auth volume is mounted only into the helper containers that do the
  sign-in steps and into the one that asks for an access token: `windlass login token --json --valid-for 20m`
  there prints a token of the user's that is good for at least twenty minutes more, and refreshes the sign-in
  first when the saved token has less left. A turn is handed that token in a file in its sandbox
  (`~/.local/share/windlass/access-token-<sandbox id>.json`, one per session, readable by its owner only), and
  Windlass is started with `WINDLASS_ACCESS_TOKEN_FILE` naming it. The file is removed when the turn ends. Demo
  turns are handed nothing. When the sign-in is gone, has expired or its token is rejected, the turn ends by
  asking the user to sign in with ChatGPT again; when the platform could not get or replace the token for
  another reason, it ends by saying so and that the sign-in is untouched.
- **Keeping the token fresh.** A token lasts about an hour and a turn may run 45 minutes. Three durations
  (`server/src/sandbox/handoff.ts`) decide when the sign-in is refreshed, and none of them depends on a window
  inside Windlass:

  | Duration | Value | What follows from it |
  |---|---|---|
  | Time a token has left when it is handed to a turn or written as a replacement | at least 20 minutes | it is what Windlass is asked for |
  | Time the token in a turn's file has left when the file is replaced | 10 minutes | a turn's file is not replaced in its first ten minutes, and a replacement that fails has ten minutes to be tried again |
  | Time a fetched token has left when it stops serving the user's other sessions | 20 minutes | a new token is shared for its first forty minutes |

  When a file is due, the token in it has less than what is asked for, so asking gives another token whenever
  that moment comes. Windlass refreshes only when it is asked and the saved token has less than twenty minutes
  left, so one user's sign-in is refreshed every forty minutes at most (1.5 times an hour, however many sessions
  run), and not at all while that user runs nothing. Each refresh is a request to OpenAI that rotates the
  sign-in's refresh token. A replacement that fails is logged (`[wlp] token.replace_failed`) and tried again
  every 20 seconds, more slowly when the sign-in itself is refused; by itself it never ends a turn. Should
  OpenAI issue tokens that last less than twenty minutes, Windlass says so; the platform uses each such token
  until half of what it had left is gone and logs `[wlp] token.short` once per user.
- **What went wrong with a token.** Windlass names each failure of a sign-in by a stable code: on the error a
  turn's prompt is answered with, on the model call that failed (`step.failed`), and in the brackets of the one
  line `windlass login token` fails with (`windlass: sign-in failed: <message> (<code>)`). The platform decides
  from that code what a failure means, never from the words of the message (`server/src/sandbox/handoff.ts`):

  | Windlass's code | Reported by | The turn ends as | Which says |
  |---|---|---|---|
  | `handed_in_missing`, `handed_in_unreadable`, `handed_in_empty`, `handed_in_malformed` | the turn | `token_unavailable` | Windlass could not read the token it was handed; the sign-in is untouched, send the prompt again. (`auth_required` when the token source says there is no sign-in any more: forgetting a sign-in removes the token files of running turns) |
  | `handed_in_expired` | the turn | `auth_required` when the token source says the sign-in is gone or no longer accepted, otherwise `token_unavailable` | sign in with ChatGPT again; or: the token ran out and the platform did not replace it in time (with the reason, when there is one), the sign-in is untouched |
  | `handed_in_rejected` | the turn | `auth_required` | ChatGPT rejected the token: sign in with ChatGPT again. (When the token had run out as well by the platform's clock, as for `handed_in_expired`) |
  | `network_error` | the turn | what Windlass reported (`execution_failed`) | Windlass's own sentence: a connection problem, not a sign-in problem |
  | `network_error` | the token source | `token_unavailable` | the sign-in service could not be reached; the sign-in is untouched, send the prompt again |
  | `signed_out` | the token source | `auth_required` | sign in with ChatGPT |
  | `invalid_grant`, `invalid_client`, `unauthorized_client`, `access_denied`, `invalid_request`, `invalid_scope`, `http_400`, `http_401`, `http_403` | the token source | `auth_required` | the sign-in is no longer accepted: sign in with ChatGPT again. A turn that is running tries its token file again more and more slowly |
  | any other code of a refresh (`refresh_locked`, `bad_token_response`, `server_error`, ...) | the token source | `token_unavailable` | the sign-in could not be refreshed, with Windlass's sentence and the code; the sign-in is untouched |
  | a `handed_in_...` code the platform does not know | the turn | `token_unavailable` | Windlass could not use the token: send the prompt again, and sign in again if it ends the same way |
  | any other code | the turn | what Windlass reported | Windlass's own sentence |

  Words are read in three places only, where there is no code. `windlass login token` reports that nobody is
  signed in on a line of its own, without one. A sandbox keeps the Windlass of the image it was made from, so an
  agent made before the image was rebuilt may run one that reads a handed-in token and gives no codes yet: its
  sentences, which no longer change, are read as before. And a Windlass that does not know the platform's command
  line at all says which part it does not know.
- **Sandboxes.** Two profiles work, both on local Docker. The picker lists four more and says what each needs.

| Profile | Outer layer | Inner layer | Windlass runs with | Commands |
|---|---|---|---|---|
| Docker + Windlass sandbox | container, non-root, no capabilities | Windlass's bubblewrap sandbox | `--approval auto` | no network, cannot read the turn's access token |
| Docker, hardened | container under Docker's default seccomp and AppArmor | none | `--approval full` | network, can read the turn's access token |

In neither profile can a command read the ChatGPT sign-in: it is not in the container. The access token a command
can read in the hardened profile lasts about an hour, and whoever reads it cannot renew it. When such a command
prints the token as it is, the platform takes it out of the turn's events, so it does not reach the timeline.

Bubblewrap only starts in a container run with `seccomp=unconfined`, `apparmor=unconfined` and
`systempaths=unconfined`, so the first profile trades Docker's own filters for Windlass's sandbox. Containers
share the host's kernel either way: for users you do not trust, the outer layer should be a virtual machine.

## Layout

| Path | What it holds |
|---|---|
| `server/src/contract.ts` | The contract between the actors and the web app: types only |
| `server/src/actors/` | The four actors |
| `server/src/sandbox/api.ts` | The sandbox layer's interface; everything about Docker and the `windlass` command line is behind it |
| `server/src/sandbox/` | That layer on Docker: containers, volumes, running a turn, the sign-in steps, the access tokens and their hand-off to a turn, the demo scripts |
| `server/src/sandbox-fake.ts` | The same interface in memory, for tests |
| `sandbox/` | The sandbox image, `build.sh`, `cleanup.sh` |
| `web/` | The web app (Vite, React); `src/api/rivet.ts` is the real client, `src/api/mock.ts` the mock |
| `fixtures/windlass-events/` | Recorded Windlass events, used by the fake layer, the mock and the reducer's tests |
| `scripts/` | `dev.sh`, `e2e.ts` (the actors), `sandbox-check.ts` (the sandbox layer) |

## Checks

```sh
pnpm -r typecheck
pnpm --filter @windlass-platform/web test                         # the timeline reducer against every fixture
cd server && pnpm e2e                                             # the actors, fake sandboxes
cd server && WLP_DEMO=1 pnpm e2e:docker                           # the actors, real containers
cd server && npx tsx ../scripts/sandbox-check.ts                  # the sandbox layer on its own
```

The end-to-end scripts start their own server on port 6420, so stop a running one first.

## Configuration

| Variable | Effect |
|---|---|
| `WLP_DEMO` | `1`: offer the demo sign-in (scripted model). `scripts/dev.sh` sets it |
| `WLP_SANDBOX` | `docker` (default) or `fake` |
| `WLP_SECRET` | signs tokens; when unset one is generated in `.data/secret` |
| `WLP_WEB_ORIGINS` | origins the web app may connect from, comma-separated (default `localhost:5173`, `127.0.0.1:5173`) |
| `WLP_TURN_TIMEOUT_MS` | how long one turn may run (default 45 minutes). The durations that keep its access token fresh are constants and hold for a turn of any length |
| `WLP_LOGIN_TTL_MS` | how long a sign-in attempt stays open (default 10 minutes) |
| `WLP_QUESTION_TIMEOUT_MS` | how long a question waits for an answer before the platform declines it (default 10 minutes) |
| `WINDLASS_BINARY` | the executable `sandbox/build.sh` puts in the image (default: the local build with `login token --valid-for`, see "Run it") |
| `WLP_SANDBOX_IMAGE` | `sandbox/build.sh` only: another tag for the image it builds, for a throwaway image; the server always uses `windlass-platform-sandbox:latest` |
| `VITE_WLP_ENDPOINT` | the Rivet endpoint the web app connects to (default `http://localhost:6420`) |
| `VITE_WLP_MOCK` | `1`: the web app runs on its mock, with no server |

Actor data is in `.data/.rivetkit`; stop the server and remove that directory to start from nothing.
`sandbox/cleanup.sh --keep-image` removes every container and volume this project made, saved sign-ins included.

A platform that was used before sign-ins had a volume of their own still has each user's `auth.json` in
`wlp-user-<uid>`. The first time such a user is touched, the server moves it to `wlp-auth-<uid>` and logs
`[wlp] sign-in.moved uid=<uid>`. An agent made before that keeps its sandbox, which was made from the older
image: its files and its timeline are there, and demo agents go on working, but its Windlass cannot run on a
handed-in token, so a prompt on a ChatGPT sign-in ends by saying so and asking for a new agent. An agent whose
sandbox was made from an image whose Windlass does read a handed-in token goes on working after the image is
rebuilt, also when that Windlass is older than the codes ("What went wrong with a token" above).

## Limits

- **It is a development deployment.** The local Rivet engine accepts anyone who can reach port 6420, and its
  control-plane token is a fixed default. Do not expose it.
- **ChatGPT sign-in for a hosted service needs OpenAI's agreement.** The flow used here is the one OpenAI
  documents for open-source, self-hosted apps.
- **The hardened profile never asks.** Windlass runs there with `--approval full`, since without its own sandbox
  every command would otherwise need an answer.
- **Signing out only forgets the token in the browser.** The token stays valid until it expires (30 days).
- **Each demo sign-in leaves a small volume** until `sandbox/cleanup.sh` runs.
- **An access token that was handed out stays valid until it expires.** Forgetting a sign-in removes it and the
  token files of running turns, but a token a command already read in the hardened profile works for the rest of
  its hour.
- **E2B, Daytona, Firecracker and agentOS are listed, not built.** E2B and Daytona no longer wait on Windlass: a
  session on another machine would be handed a short-lived access token as the Docker sessions are. Each needs a
  provider in the sandbox layer, an image with Windlass in it and an account. Firecracker needs a host with KVM
  and a guest agent; agentOS cannot run the Windlass executable at all.
