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

scripts/dev.sh                              # the server: Rivet endpoint on http://localhost:6420, its own routes on :6440, demo sign-in on
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

When the browser is on another machine, forward ports 5173, 6420 and 6440, or set `VITE_WLP_ENDPOINT` (web) and
`WLP_WEB_ORIGINS` (server) to the addresses you use (the web app looks for the server's routes on the endpoint's
host, port 6440, unless `VITE_WLP_API` says otherwise).

Without Docker, `WLP_SANDBOX=fake scripts/dev.sh` runs in-memory sandboxes that replay recorded Windlass runs, and
`VITE_WLP_MOCK=1 pnpm --filter @windlass-platform/web dev` runs the web app with no server at all.

## How it fits together

```
browser ── HTTP ───────▶ any server (:6440)  GET /platform/info   what this deployment offers; no actor
browser ── WebSocket ──▶ Rivet endpoint (:6420)
                           │
                           ├─ login         [attemptId]         one sign-in attempt
                           ├─ user          [uid]               profile, the index of sessions, the ChatGPT
                           │                                    sign-in (encrypted) and its access tokens
                           └─ agentSession  [uid, sessionId]    timeline in SQLite, one sandbox
                                               │
                                               ▼
                                   Docker container  wlp-session-<id>
                                     /workspace                        the agent's files
                                     ~/.local/share/windlass           volume wlp-user-<uid>: Windlass's own
                                                                       session logs and memory, and the turn's
                                                                       access token file. No sign-in
                                     windlass acp                      one process per turn
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
- **Idle sandboxes.** A sandbox costs money while it runs, whether or not a browser is open. Ten minutes after a
  session's last turn ended (`WLP_IDLE_SUSPEND_MS`) the session suspends its sandbox, and after seven days
  without use (`WLP_IDLE_DESTROY_MS`) it removes it with its files. The timeline stays, and gets one line for
  each ("Suspended the sandbox after 10 minutes without use; the next prompt resumes it."). The actor's own
  durable schedule (`c.schedule`) does it, so it happens while the actor sleeps and after a restart: the
  engine wakes the actor when the time comes. A turn that runs, or waits on the user's answer, is never cut off;
  the check is set again when it ends. The next prompt resumes a suspended sandbox, or makes a new one after a
  removal. Reading the workspace's changes starts a suspended sandbox too and counts as use. A suspended
  session counts as idle: it holds none of the user's `MAX_RUNNING_SESSIONS` places.
- **Sign-in.** Windlass does it itself. `login.start()` runs `windlass login start` and returns the OpenAI
  address. The browser ends on `http://127.0.0.1:1455/auth/callback`, which does not load; the user pastes that
  address, and `login.finish()` feeds it to `windlass login finish`. The saved sign-in goes to the user's `user`
  actor, encrypted ("Sign-ins" below). The platform's own token is an HMAC-signed string, checked in
  `onBeforeConnect` and again in every action.
- **No sandbox holds the sign-in.** It is in the user's actor and nowhere else, and that actor is the one place
  that asks Windlass for an access token: `windlass login token --json --valid-for 20m` prints a token of the
  user's that is good for at least twenty minutes more, and refreshes the sign-in first when the saved token
  has less left. A turn is handed that token in a file in its sandbox
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

## Sign-ins

A user's ChatGPT sign-in is what Windlass keeps in its data directory: `auth.json` (the account, the access
token and its expiry, the refresh token, the ID token) and `host-id`. The platform never makes or reads those
tokens itself. It stores the files and lends them to Windlass for one command at a time
(`server/src/signin/`).

**Where it is.** In the user's `user` actor, one row, encrypted. A sign-in attempt between `start` and
`finish` (Windlass's `auth-pending.json`: the PKCE verifier, state and nonce) is in its `login` actor the same
way, so the two steps can be served by different servers. Actor storage is the Rivet engine's, which with
Rivet Cloud is a third party's:

| What | Where | Sealed for | Until |
|---|---|---|---|
| the user's sign-in (`auth.json`, `host-id`) | `user` actor, table `signin`, column `sealed` | that uid | it is replaced or forgotten |
| a pending attempt (`auth-pending.json`, `host-id`) | `login` actor, table `attempt`, column `sealed` | that attempt id | `finish`, or the attempt expires (10 minutes) |
| a finished attempt | the same place | that attempt id | the user's actor has taken it, moments later |
| an access token on its way to the server that runs the turn | not stored: an actor's answer, through the engine | that uid and that request | it is read |

Each is AES-256-GCM (`server/src/signin/seal.ts`) under a key derived with HKDF-SHA256 from `WLP_SIGNIN_KEY`,
or from `WLP_SECRET` when that is unset, with a label of its own: it is not the key tokens are signed with.
The key is in the servers' environment and never in actor storage. What a blob is for and whose it is are
authenticated with it, so one user's sign-in put into another user's actor does not open there, and an
attempt's material does not open as a sign-in. Next to the blob the `user` actor stores a counter of how often
the sign-in changed, whether a line about short tokens was already logged, and when the row was last written.

Someone with a copy of the actor storage and without the key learns which users have a sign-in, how long each
blob is, and when it last changed (so, roughly, when its user was active). They learn no token, no refresh
token and no PKCE secret, and, from these rows, no account. (The email is in the same actor's `profile` table,
which is not encrypted, and the uid the actor is named by is a hash of the OpenAI account id: whoever knows an
account id can tell whether it has a user here.) Someone who can also write to the storage can put back an
older blob of the same user (a sign-in that was forgotten, or one from before a refresh, which the sign-in
service then refuses); they cannot make one user's blob work for another. Forgetting a sign-in empties the
row; what the engine keeps of earlier versions of a row is the engine's, and is ciphertext.

With the key, everything is readable, so the key must not be where the storage is. That holds when the engine
is hosted elsewhere and the servers are your own: the secret is in the servers' environment only. It does not
hold on a Rivet Cloud cluster, where Rivet also runs the servers and keeps their secrets
(`rivet cluster secret set WLP_SECRET`): there the encryption protects a copy of the actor storage, such as a
backup, and not against whoever runs the cluster. The key must be the same on every server and must not
change: with another key a stored sign-in does not open, the server logs `[wlp] sign-in.unreadable`, and the
user is asked to sign in with ChatGPT again.

**Running Windlass's commands.** For each command a runner makes a private directory (mode 0700), writes the
sign-in's files into it (0600), runs `windlass login ...` with `XDG_DATA_HOME` pointing there (Windlass looks
for its data in `$XDG_DATA_HOME/windlass`) and without `WINDLASS_ACCESS_TOKEN_FILE`, reads the files back, and
removes the directory: after success, failure, a timeout, an abort, and when Windlass could not be started.
The files are read back after a failure too, because a command can fail after the refresh token was already
replaced. There are two runners:

| Runner | Runs | For |
|---|---|---|
| local (`WLP_WINDLASS_BIN`) | a Windlass executable on the server, as a process. The directory is under `/dev/shm` where there is one (memory, never a disk), else the system's temporary directory; `WLP_SIGNIN_TMPDIR` names another place | deployments: no Docker on the server |
| Docker | a throwaway container of the sandbox image. The files go in on its standard input and come back on its standard output; the directory is in the container's memory. No volume, nothing on the host | development on a machine that has the image |

The server uses the local runner when `WLP_WINDLASS_BIN` is set. Without it, a server whose sandboxes are
Docker's uses the Docker runner, and any other server the local one with `windlass` from its `PATH`;
`WLP_SIGNIN_RUNNER=local|docker` says it outright. The Windlass must have `login token --valid-for` ("Run
it"): `signInProblem()` (`server/src/signin/index.ts`) says when the server's own cannot be run or is too old,
and a turn that needs a token fails with the same sentence.

**One refresh at a time.** A refresh replaces the refresh token, so two servers refreshing one sign-in at once
would break it. Whichever server runs a turn, `AccessTokens.current(uid)` is a call to that user's actor, and
an actor runs in one place at a time: it answers from the token it keeps in memory while that has twenty
minutes left, and otherwise runs one `windlass login token` however many are asking. When Windlass refreshed,
the actor saves the new sign-in and only then answers (`[wlp] sign-in.refreshed uid=...`). If the save fails,
no token is handed out, and the save is tried again before Windlass is asked again. The answer is encrypted
for the request that asked, so the engine that carries it does not see the token.

What cannot be closed: a server that dies after OpenAI answered the refresh and before the actor's save has
returned. Windlass has the new sign-in in its private directory, exits, the runner reads it, the actor encrypts
and writes it: tens of milliseconds, plus the storage's round trip. If the server dies in that time, the store
keeps the old refresh token, which OpenAI has used up. The next refresh is refused, the user's turns end with
"Your ChatGPT sign-in is no longer accepted ... Sign in with ChatGPT again", and signing in again mends it.
Nothing else is lost and no other user is affected. A command that is stopped at its time limit is not this
case: what Windlass had saved is still read back and stored.

**Replacing and forgetting.** A new sign-in replaces the old one in the same queue the token requests wait in,
and a `windlass login token` that is running for the old one is stopped rather than waited for: once `adopt`
or `logout` has returned, no token of the old sign-in is handed out. `user.forgetChatgpt()` forgets the
caller's sign-in; the web app has no button for it yet. Forgetting also has the sandbox provider remove the
token files of the user's running turns. On Docker that is done in the user's data volume, on the machine that
has it. A provider whose sandboxes are elsewhere has to do the same for its own: on E2B, remove
`access-token-*.json` from Windlass's data directory in each of the user's running sandboxes (they are listed
by the metadata `wlp_uid`). Until it does, a turn that is running on E2B goes on with the token it has
until that token expires, within the hour, and then ends asking for a sign-in; it is given no new one.

**Sign-ins of the first version.** A machine that ran it has a Docker volume `wlp-auth-<uid>` per signed-in
user (and before that, `auth.json` in `wlp-user-<uid>`). The first time such a user is touched, the Docker
layer reads the volume, the user's actor stores the sign-in encrypted, and the volume is removed:
`[wlp] sign-in.imported uid=<uid>: ...`. If the actor already holds a sign-in, that one is newer and the
volume is only removed. This works on the machine that has the volumes, and only there.

| Variable | Effect |
|---|---|
| `WLP_SIGNIN_KEY` | what the key that encrypts sign-ins is derived from; at least 32 characters, the same on every server. Unset: derived from `WLP_SECRET`. Setting it lets `WLP_SECRET` change without every user signing in again |
| `WLP_WINDLASS_BIN` | a Windlass executable on the server, for the sign-in commands (a path, or a name on `PATH`; default `windlass`) |
| `WLP_SIGNIN_RUNNER` | `local` or `docker`; default: `local` when `WLP_WINDLASS_BIN` is set, else `docker` with Docker sandboxes, else `local` |
| `WLP_SIGNIN_TMPDIR` | where the local runner makes its private directories (default `/dev/shm`, else the system's temporary directory) |

## Running on several servers

Every server is one Rivet node. With `RIVET_ENDPOINT` set it starts no engine of its own: it opens an outbound
connection to the one engine all servers share, and that engine places each actor on one of them, wakes it on
another when its server stops, keeps every actor's SQLite data and runs every actor's schedule. Nothing of a
user or a session is kept on a server. Browsers reach the actors through the engine's gateway, never through a
server; a server's own port serves only `GET /platform/info` and `/health`, and any server answers either.

What every server needs, the same on all of them:

| Variable | Value |
|---|---|
| `RIVET_ENDPOINT` | `https://<namespace>:<secret token>@<engine host>`: the engine, the namespace the actors live in, and a secret token (`sk_...`) of that namespace. `RIVET_NAMESPACE` and `RIVET_TOKEN` may carry the last two instead |
| `RIVET_POOL` | the node pool to join (default `default`); the engine refuses a node whose pool does not exist |
| `RIVET_NODE_VERSION` | a number that goes up with every deploy, so that new and woken actors go to the newest servers |
| `NODE_ENV` | `production`: RivetKit then never starts an engine of its own |
| `WLP_SECRET` | one secret, at least 16 characters (`openssl rand -hex 32`), the same on every server: a token one server signs must pass on all. A server with `RIVET_ENDPOINT` and no `WLP_SECRET` stops with `[wlp] WLP_SECRET is not set: ...` and nothing else |
| `WLP_SANDBOX` | `e2b`. Docker sandboxes exist on the machine that made them, and a session's actor can wake on any server, so the Docker layer only works with one server |
| `WLP_WEB_ORIGINS` | the web app's address |
| `WLP_WINDLASS_BIN` | a Windlass executable on the server, for the sign-in commands ("Sign-ins"). `server/Dockerfile` puts one at `/usr/local/bin/windlass` and sets this |
| `WLP_SIGNIN_KEY` | optional; when set, the same on every server: what the key that encrypts sign-ins is derived from, in place of `WLP_SECRET` |
| `WLP_DEMO`, `WLP_TURN_TIMEOUT_MS`, `WLP_QUESTION_TIMEOUT_MS`, `WLP_IDLE_SUSPEND_MS`, `WLP_IDLE_DESTROY_MS` | the same values everywhere: a session's limits are applied by whichever server holds its actor |
| `WLP_HTTP_PORT` or `PORT` | the port the load balancer sends `/platform/info` to |

The web app is built with `VITE_WLP_ENDPOINT=https://<namespace>:<public token>@<engine host>`: a public token
(`pk_...`), not a secret one, which may sit in a browser; and not a connection token (`ck_...`) either, which
cannot create actors, as the web app does for a sign-in attempt and a user. `VITE_WLP_API` is the address in
front of the servers' HTTP port.

Shared by all servers: the engine with the actors' data and schedules, `WLP_SECRET`, and the sandbox provider.
Kept by each server for itself, and rebuilt when it is asked again: the cached platform information and the
sandbox layer's own caches. Still on one machine: the Docker layer. The ChatGPT sign-ins are not: they are in
the users' actors, and every server needs `WLP_WINDLASS_BIN` (and the same `WLP_SIGNIN_KEY`, when it is set) to
run Windlass's sign-in commands ("Sign-ins").

**On a Rivet Cloud cluster.** A cluster is an engine run by Rivet with nodes run by Rivet: the server is built
into an image and runs on the cluster's own node, which sets the connection and pool variables itself. From the
repository root:

```sh
rivet cluster secret set WLP_SECRET           # prompts for the value
rivet cluster secret set E2B_API_KEY          # and whatever else the E2B layer reads
rivet deploy --cluster <cluster> --dockerfile server/Dockerfile --build-context . \
  --secret WLP_SECRET --secret E2B_API_KEY \
  --env WLP_SANDBOX=e2b --env WLP_WEB_ORIGINS=https://<web app>
```

The CLI builds the image for linux/amd64 and prints the pool's public address, which serves the port in `PORT`:
that address is `VITE_WLP_API`. There is no Docker on a cluster's node, so `WLP_SANDBOX=e2b` is required there.
The web app's endpoint and public token are the cluster's, from its dashboard. The cluster rolls its pool from
one build to the next itself; if the server says `node version defaulted` when it starts there, add
`--env RIVET_NODE_VERSION=<n>`, a number that goes up with every deploy.

**On servers of your own.** Each runs the same image, or `cd server && npx tsx src/index.ts`, with the
variables above, behind a load balancer for port 6440. The Rivet docs describe such nodes joining an engine by
`RIVET_ENDPOINT` and a secret token; whether a Rivet Cloud cluster accepts nodes of your own beside its hosted
one, they do not say.

## E2B

With `WLP_SANDBOX=e2b` a session's sandbox is a microVM at [E2B](https://e2b.dev) instead of a container on the
server's machine, so any server of a deployment reaches any session's sandbox. A deployment has one provider:
a server on E2B offers the E2B profile and no Docker profile. Nothing of this has run against E2B yet: there
was no account when it was written, and `scripts/e2b-check.ts` is what tries it.

```sh
sandbox/e2b/build-windlass-x64.sh                                   # the x86_64 Windlass E2B needs, from the local checkout
E2B_API_KEY=e2b_... sandbox/e2b/build.sh                            # builds the template windlass-platform-sandbox at E2B
cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-check.ts    # one sandbox, one scripted turn, about two minutes
WLP_SANDBOX=e2b E2B_API_KEY=e2b_... WLP_WINDLASS_BIN=/path/to/windlass npx tsx src/index.ts
```

`sandbox/e2b/build.sh --print` shows what E2B would be asked to build and needs no key. The template is made
from the Docker image's own `sandbox/Dockerfile`, so a microVM has what a container has: the user `agent`,
`/workspace`, Windlass's data directory, `wlp-run`, git, bubblewrap and Windlass. A server on E2B needs no
Docker: Windlass's sign-in commands run from `WLP_WINDLASS_BIN`, an executable for the server's own machine.
E2B's SDK (`e2b` 2.63.0, loaded only by a server on E2B) needs Node 22.19 or later.

- **What the profile promises.** Whether Windlass's bubblewrap sandbox works inside an E2B microVM is not known
  until the check has run, so the profile promises nothing of it: commands may have network and may read the
  session's access token. Windlass runs with `--approval auto` and probes bubblewrap itself: where the probe
  passes it sandboxes commands, where it fails it asks before every command. The check prints which (`ANSWER:`).
  If bubblewrap works, `WLP_E2B_WINDLASS_SANDBOX=1` makes the profile promise what the first Docker profile
  promises, and every new sandbox is held to it: one in which the probe fails is removed and not handed out.
- **A turn** is the same process as in a container, `wlp-run exec <tag> windlass acp`, started through E2B's
  command API; the access token file is written the same way, the token on the command's standard input.
- **Windlass's data directory is on the microVM's own disk**, not on a volume (E2B's volumes are a private beta
  in which file locks can hang, and Windlass keeps SQLite databases there). A session's Windlass session lives
  and ends with its sandbox, and no session sees another's files, also not the token file of the same user's
  other turn. A pause keeps it. When a sandbox is gone (killed, or lost), the session gets a new one with an
  empty workspace, and the first prompt that names the old Windlass session ends with `session_not_found`: the
  timeline says so, and the next prompt starts a new Windlass session. On Docker the data directory is a
  volume of the user's and outlives a sandbox.

Using little of E2B is built in. The free Hobby plan runs on a one-time credit of $100 and allows 10 sandboxes
at once and one hour of running without a pause; every default is well inside that.

| What | How | Default |
|---|---|---|
| Size of a sandbox | the template's, set when it is built: `WLP_E2B_CPU`, `WLP_E2B_MEMORY_MB` for `sandbox/e2b/build.sh` | 1 vCPU, 1024 MiB |
| Sandboxes running at once | `WLP_E2B_MAX_RUNNING`, counted from E2B's own list of the deployment's running sandboxes before one is created or resumed, and again after, so it holds across servers. At the cap the user reads: "This deployment runs at most 3 sandboxes at the same time, and all of them are in use. Try again in a few minutes; an agent's sandbox is freed shortly after its turn has ended." | 3 |
| A sandbox nobody uses | its own timeout at E2B, `WLP_E2B_IDLE_TIMEOUT_MS`: E2B pauses it by itself that long after the last use | 2 minutes |
| A sandbox whose server died | while a turn runs, the server pushes the timeout out to `WLP_E2B_TURN_LEASE_MS` every third of it; a dead server stops doing so, and E2B pauses the sandbox | 3 minutes |
| Suspend and destroy | `suspend` pauses: files and memory are kept, nothing is billed, and E2B keeps a paused sandbox without limit. `destroy` kills. With `WLP_E2B_PAUSE=0`, for an account that cannot pause, both the timeout and `suspend` kill, and the session's files and Windlass session are lost each time | pause |
| The plan's hour | a sandbox with too little left of `WLP_E2B_MAX_RUNTIME_MS` for a turn is paused and resumed before the turn starts, which starts the hour again | 1 hour |
| Finding them again | every sandbox carries `wlp_deployment` (`WLP_E2B_DEPLOYMENT`), `wlp_uid`, `wlp_session` and `wlp_profile` in its metadata; only sandboxes with the deployment's mark are ever touched | `default` |

A sandbox of the default size costs about $0.0000185 a second while it runs ($0.067 an hour) and nothing while
it is paused, by E2B's published prices; with the default cap a deployment cannot spend more than about $0.20
an hour. Each time a sandbox stops running through a server, a line says how long it ran and what that costs:

```
[wlp] e2b.sandbox.paused id=... uid=... session=...: it ran 182 s at 1 vCPU and 1024 MiB, $0.0034 (estimated)
```

Every such number is an estimate: the prices are in one file (`server/src/sandbox/e2b/pricing.ts`), the time is
the server's own measurement, and E2B's usage page has what was billed.

```sh
cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-cleanup.ts            # lists the deployment's sandboxes; changes nothing
cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-cleanup.ts --kill     # removes them, paused ones too
cd server && npx tsx ../scripts/e2b-provider-test.ts                         # the provider on an in-memory E2B: no account, nothing sent
cd server && flock /tmp/wlp-test.lock npx tsx ../scripts/e2b-provider-test.ts --docker
                                                                             # and real scripted turns through it, in local containers
```

The provider's logic is written against a small interface of its own (`server/src/sandbox/e2b/client.ts`);
`sdk.ts` maps it to E2B's SDK and `fake.ts` keeps it in memory for the tests. Limits of this provider: a paused
sandbox is kept at E2B, at no charge, until its session is deleted, the session's sandbox is removed for not
being used (`WLP_IDLE_DESTROY_MS`) or `e2b-cleanup.ts` removes it; opening a session's changes in the browser
resumes its sandbox for the length of the idle timeout; and a turn whose command stream to E2B breaks ends as
a failed turn, though the sandbox goes on until its timeout.

## Layout

| Path | What it holds |
|---|---|
| `server/src/contract.ts` | The contract between the actors and the web app: types only |
| `server/src/actors/` | The three actors |
| `server/src/index.ts`, `platform-info.ts` | The server: one Rivet node, and its HTTP routes (`/platform/info`, `/health`) |
| `server/Dockerfile` | The server as an image, for a Rivet Cloud cluster or a machine of your own ("Running on several servers") |
| `server/src/sandbox/api.ts` | The sandbox layer's interface; everything about Docker and the `windlass` command line is behind it |
| `server/src/sandbox/` | That layer on Docker: containers, volumes, running a turn, the hand-off of an access token to a turn, the demo scripts |
| `server/src/signin/` | The ChatGPT sign-in for every layer: Windlass's sign-in commands and where they run, the encryption, and the one place per user that asks for an access token |
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
cd server && npx tsx ../scripts/signin-check.ts                   # the sign-in machinery: no server, no Docker, a stand-in for OpenAI
```

The end-to-end scripts start their own server on ports 6420 and 6440, so stop a running one first.

## Configuration

| Variable | Effect |
|---|---|
| `WLP_DEMO` | `1`: offer the demo sign-in (scripted model). `scripts/dev.sh` sets it |
| `WLP_SANDBOX` | `docker` (default), `e2b` ("E2B") or `fake` |
| `WLP_SECRET` | signs tokens; when unset one is generated in `.data/secret`. Required with a remote engine (`RIVET_ENDPOINT`): the server refuses to start without it |
| `WLP_WEB_ORIGINS` | origins the web app may connect from, comma-separated (default `localhost:5173`, `127.0.0.1:5173`) |
| `WLP_TURN_TIMEOUT_MS` | how long one turn may run (default 45 minutes). The durations that keep its access token fresh are constants and hold for a turn of any length |
| `WLP_LOGIN_TTL_MS` | how long a sign-in attempt stays open (default 10 minutes) |
| `WLP_QUESTION_TIMEOUT_MS` | how long a question waits for an answer before the platform declines it (default 10 minutes) |
| `WLP_IDLE_SUSPEND_MS` | how long after a session's last turn ended its sandbox is suspended (default 10 minutes) |
| `WLP_IDLE_DESTROY_MS` | how long after its last use a sandbox is removed with its files; the timeline stays (default 7 days) |
| `WLP_HTTP_PORT` | the port of the server's own routes, `/platform/info` and `/health` (default `PORT` when that is set, else 6440) |
| `WLP_HTTP_HOST` | the address they bind (default `127.0.0.1` with the local engine, `0.0.0.0` with a remote one) |
| `RIVET_ENDPOINT`, `RIVET_NAMESPACE`, `RIVET_TOKEN`, `RIVET_POOL`, `RIVET_NODE_VERSION` | RivetKit's own: the engine to join instead of starting a local one ("Running on several servers") |
| `WINDLASS_BINARY` | the executable `sandbox/build.sh` puts in the image (default: the local build with `login token --valid-for`, see "Run it") |
| `WLP_SANDBOX_IMAGE` | `sandbox/build.sh` only: another tag for the image it builds, for a throwaway image; the server always uses `windlass-platform-sandbox:latest` |
| `VITE_WLP_ENDPOINT` | the Rivet endpoint the web app connects to (default `http://localhost:6420`); may carry a namespace and a public token, `https://<namespace>:<pk_...>@<host>` |
| `VITE_WLP_API` | where the web app asks for `/platform/info` (default: the endpoint's host on port 6440 when the endpoint is on 6420, else `http://localhost:6440`) |
| `VITE_WLP_MOCK` | `1`: the web app runs on its mock, with no server |

Actor data is in `.data/.rivetkit`; stop the server and remove that directory to start from nothing.
`sandbox/cleanup.sh --keep-image` removes every container and volume this project made, sign-ins of the first
version that were never taken in included; the sign-ins in the users' actors go with the actor data.

A platform that was used before sign-ins were kept in the users' actors still has them in Docker volumes;
"Sign-ins" says how they are taken in. An agent made before sign-ins left the sandboxes keeps its sandbox, which was made from the older
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
- **The test suites never call E2B.** They run the E2B provider on a stand-in for E2B's service. Only
  `scripts/e2b-check.ts` runs it against the real one ("E2B"): one sandbox for under a minute.
- **Daytona, Firecracker and agentOS are listed, not built.** Daytona does not wait on Windlass: a session on
  another machine would be handed a short-lived access token as the other sessions are. It needs a provider in
  the sandbox layer, an image with Windlass in it and an account. Firecracker needs a host with KVM and a guest
  agent; agentOS cannot run the Windlass executable at all.
