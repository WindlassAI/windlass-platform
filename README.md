# Windlass Platform

A hosted home for [Windlass](https://github.com/parthg1901/windlass), the terminal coding agent: sign in with
ChatGPT, launch agents, choose the sandbox each one works in, and watch every turn live in the browser.

It is built on [Rivet Actors](https://www.rivet.dev/actors/docs). Each agent session is one actor that owns the
conversation and drives a Windlass process inside a sandbox.

![A session: the agent's tool calls, its answer, and the session panel](docs/screenshots/session.png)

![The agent asks before a command gets network access](docs/screenshots/question.png)

## Run it

You need Node 22 or later, pnpm and Docker. The Windlass the platform runs is the released 0.3.0, which the
build scripts fetch by themselves (`sandbox/fetch-windlass.sh`: the release is pinned there by tag and by the
SHA-256 of each executable, and a file that does not match is not installed).

What the platform needs of a Windlass, should you try another one: it can hand its sign-in's access token to
another Windlass and be asked for one that is good for a while yet (`windlass login token --valid-for <duration>`
and `WINDLASS_ACCESS_TOKEN_FILE`), it names every failure of a sign-in by a stable code, and it lists an
account's models on such a token, one JSON object on a line (`windlass --models --json`; "Models"). 0.3.0 also has three
things the platform uses where a sandbox's Windlass has them, and does without where it has not: a home of the
session's own for sandboxed commands ("Sandboxes" below), two lists that say by name which variables a
command gets ("A repository's secrets"), and required checks, which a repository's own file cannot replace
("A repository's checks"). The released 0.2.0 has the first two and not the third. The local builds before
0.2.0 all call themselves 0.1.1: `0.1.1+a9c3601d40` is the same code as 0.2.0, `0.1.1+739e1cbc09` has the
token option and none of the three later things, and `0.1.1+dca57b2627` has `login token` without
`--valid-for` and is too old.

A sandbox keeps the Windlass it was made with, so a session whose sandbox was made before the image had
0.3.0 goes on with 0.2.0 until its sandbox is replaced. It works as it did: its user's checks reach Windlass
the older way, where a repository's own list can stand in for them, and its pull requests and the
repository's page say so. A sandbox made in its place has 0.3.0, which opens every session 0.2.0 wrote, and
the user's checks are required from that turn on. The other way about does not work: 0.2.0 does not open a
session in which 0.3.0 recorded check results. So a sandbox image is not to be rolled back to 0.2.0 while
such sessions are in use ("A repository's checks", "Two kinds of Windlass", has what a turn then says and
what its user can do).

```sh
pnpm install

# Build the sandbox image, with the released Windlass. For a Windlass that is not released yet:
# WINDLASS_BINARY=/path/to/windlass-linux-<arch> sandbox/build.sh
sandbox/build.sh

scripts/dev.sh                              # the server: Rivet endpoint on http://localhost:6420, its own routes on :6440, demo sign-in on
pnpm --filter @windlass-platform/web dev    # the web app on http://localhost:5173
```

Open http://localhost:5173. "Try the demo" needs no account: it runs Windlass's real engine and real tool calls in
a real container, with a scripted model in place of ChatGPT. "Continue with ChatGPT" runs on your own plan.

With a Windlass from before 0.2.0 in the image the demo still works and nothing else does. There are two kinds: one without
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
browser ── HTTP ───────▶ any server (:6440)  GET /platform/info         what this deployment offers; no actor
                                             GET /platform/connection   where the actors are reached, and the token for it
browser ── WebSocket ──▶ Rivet endpoint (:6420)
                           │
                           ├─ login             [attemptId]          one sign-in attempt
                           ├─ user              [uid]                profile, the index of sessions, the ChatGPT
                           │                                         sign-in (encrypted) and its access tokens,
                           │                                         the models of the ChatGPT plan,
                           │                                         approvals of projects' MCP servers,
                           │                                         setup commands of repositories, their
                           │                                         checks, their secrets (encrypted) and
                           │                                         their defaults, the account's own:
                           │                                         defaults, MCP servers and their secrets
                           │                                         (encrypted), the index of machines, the
                           │                                         index of work items, the turn queue and
                           │                                         the API tokens (digests only)
                           ├─ machine           [uid, machineId]     one paired machine: its public key, its
                           │                                         runner's last report, its control socket
                           ├─ machinePairing    [pairingId]          one pairing attempt, for ten minutes
                           ├─ pairingDirectory  ["starts"]           the codes of open pairings, and their budget
                           ├─ workItem          [uid, itemId]        one work item: its run, its step, its
                           │                                         question, its log and its verdicts
                           └─ agentSession      [uid, sessionId]     timeline in SQLite, one sandbox
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
- **A message sent twice.** A call can reach an actor twice. RivetKit's client sends an action again by
  itself when the engine says the answer was lost on its way, an action that is in flight when its actor's
  instance goes away runs again in the next one, and a user who was told that the server did not answer
  presses Send again. So the web app makes a key for every submission, a random UUID, and sends it with
  every attempt of that submission: `idempotencyKey` on `prompt` and on `createSession`, named and shaped
  as the Agent Client Protocol's is, a string of 1 to 255 characters (`server/src/submissions.ts`).

  | What comes | What the session does |
  |---|---|
  | no key (left out, or null) | what it always did: every call is a message of its own. Older clients send none |
  | a key that is empty, longer than 255 characters or no string | refuses it, `bad_idempotency_key`: it is never read as no key |
  | a key it has not taken | takes the prompt as usual, and keeps the key in the same step that puts the message into the timeline |
  | a key it has taken, with the same text | answers what the first attempt was answered, `{ turn, steered }`, whatever the session does by now: no second message in the running turn, no second turn, nothing in the timeline. `model` and `effort` are the first attempt's |
  | a key whose first attempt is still being decided | nothing of its own: the attempt ends as the first one ends, with its answer or its refusal. A prompt waits on the user's actor and on the sandbox layer before it is taken, and other calls run meanwhile |
  | a key it has taken, with another text | refuses it, `idempotency_key_reused`; the key stays the first message's |

  A prompt that was refused (one of the user's limits, a ChatGPT sign-in that is needed, a turn that is
  starting or stopping) leaves its key unused, and the same key is then a new try. "Refused" and "taken, but
  the answer was lost" are told apart by one thing: whether the key is kept, which happens only in the step
  that takes the message. A turn that was taken and then failed, as when its sandbox could not be made, has
  used its key: its message is in the timeline with the turn's error, and a repeat is answered with that turn.

  A session keeps the keys of its last 50 messages that came with one (`MAX_REMEMBERED_SUBMISSIONS`), each
  with a digest of its text and its answer, in its own stored state, written when the message is: they hold
  across the actor's sleep and a restart, and cost the same in a session of five turns and of five thousand.
  The fifty-first is forgotten, and a prompt with it is a new message, as without a key. `createSession`
  goes by the same rules in the user's actor: the key is in the session's row of the user's index, so the
  same key answers with the session the first attempt made for as long as that session exists, and makes a
  new one once it was deleted. A key is never logged and never sent to a client: it is not in the timeline.

  In the web app a message that was not taken stays in the composer ("Your message is still here"), and
  sending it again unchanged is the same submission, with the same key; a message whose text changed is a new
  one. The launch form has one key for the agent and one for its first prompt, and a prompt that is handed
  to the session's screen keeps its key until its text changes. No control shows any of this. The key is not
  passed to Windlass: the Windlass the platform runs speaks ACP v1, which has no such field, and each turn's
  Windlass is reached over a local pipe that does not send anything twice.
- **Sleep.** With no browser connected and no turn running, the actor sleeps after 30 seconds and stops its
  container. The next prompt, or opening the session, starts it again with its files intact.
- **A session on a machine of the user's.** The session's actor is the same, and so is the turn: Windlass's
  protocol is spoken by the server, as above. The sandbox is a container on that machine, which the
  machine's runner makes and runs. The session has the runner open a socket to it, through the machine's
  actor and with a one-use ticket, and every operation on the sandbox goes over that socket instead of
  `docker exec` ("Machines of your own").
- **When a server stops.** On SIGTERM (a deploy) RivetKit puts every actor to sleep and exits after 20
  seconds, done or not, so a session's sleep fits in 16: a turn that runs is stopped and closed in the
  timeline (at most 10 seconds), the timeline and the session are saved, the sandbox is suspended (at most 4),
  then the idle check is set and the user's list told (at most 2), and it is saved again. The waits and the
  rule they must keep are in `server/src/actors/agent-session.ts` (`SHUTDOWN_GRACE_MS`), and the server does
  not start when they add up to more. A suspend that takes longer goes on without the session: on E2B the
  sandbox pauses at its own timeout (`WLP_E2B_IDLE_TIMEOUT_MS`, or `WLP_E2B_TURN_LEASE_MS` when a turn was
  running), on Docker the container stops as it was asked to, and the next check or prompt sees that.
- **Idle sandboxes.** A sandbox costs money while it runs, whether or not a browser is open. Ten minutes after a
  session's last turn ended (`WLP_IDLE_SUSPEND_MS`) the session suspends its sandbox, and after seven days
  without use (`WLP_IDLE_DESTROY_MS`) it removes it with its files. The timeline stays, and gets one line for
  each ("Suspended the sandbox after 10 minutes without use; the next prompt resumes it."). The actor's own
  durable schedule (`c.schedule`) does it, so it happens while the actor sleeps and after a restart: the
  engine wakes the actor when the time comes. A turn that runs, or waits on the user's answer, is never cut off;
  the check is set again when it ends. The next prompt resumes a suspended sandbox, or makes a new one after a
  removal. Reading the workspace's changes starts a suspended sandbox too and counts as use. A suspended
  session counts as idle: it is not among the user's turns running at once (`WLP_FACTORY_RUNNING_TURNS`,
  "Usage and limits").
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
  run), and not at all while that user runs nothing and opens no page that offers models: listing a user's
  models takes a token of theirs too, at most once an hour and only when they ask ("Models"). Each refresh
  is a request to OpenAI that rotates the sign-in's refresh token. A replacement that fails is logged (`[wlp] token.replace_failed`) and tried again
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

**A home for sandboxed commands.** In Windlass's sandbox the home directory is read-only, and many tools write
there without being told to: `astro build` makes `~/.config/astro`, npm and uv keep caches there. So the
platform opens every session with `"sandboxHome": "session"` (Windlass's docs/safety.md, "The session's home";
`SANDBOX_HOME` in `server/src/sandbox/turn.ts`): a sandboxed command then finds, at `/home/agent`, a home of
the session's own. What the sandbox's home holds is in it, read-only; what a command makes beside that, and
beside what is in `~/.config`, `~/.cache`, `~/.local/share` and `~/.local/state`, is kept for the session's
later commands, in `/tmp/windlass-<uid>/<Windlass session>.home` in the sandbox, and the sandbox's real home
is never written. It is said in every profile, because it applies to the commands Windlass sandboxes and to
no other:

| Profile | What it does there |
|---|---|
| `docker-windlass-sandbox`, E2B with its sandbox promised | every command is sandboxed, and gets the session's home |
| E2B before its check | the same where bubblewrap works in the microVM; where it does not, nothing is sandboxed and nothing changes |
| `e2b-open` | commands run directly in the microVM, with its real home, until content from the web or an MCP server is in the conversation. From then on Windlass sandboxes them, and without this a tool that wrote under the home until then would find it read-only. What is in the home by then stays read-only, a directory as a whole: a tool whose cache directory an earlier command already made there cannot add to it |
| `docker-hardened` | nothing: bubblewrap does not start there, so no command is sandboxed, and Windlass says nothing of it to the model or the user |

The setting is not stored with a session: it is sent with every `session/new` and `session/resume`, to a
Windlass that lists it among what it takes (below). The session's home lives and goes with the sandbox, and
is not in the copy of the agent's memory. A sandbox's files outside the workspace were never part of
"Changes" or of a push, and these are not either. The image still keeps the package managers' caches under
`/tmp/.cache` (`sandbox/Dockerfile`): a repository's setup command runs outside Windlass's sandbox, and a
cache it made in the real home would be a directory that is read-only as a whole for the commands after it.

**Sandboxes that keep an older Windlass.** A sandbox keeps the Windlass of the image it was made from: a
container from before the image was rebuilt, a paused E2B sandbox from before the template was. An older
Windlass does not refuse a key of a session's metadata it does not know; it leaves it unread, which for a
list of variables to withhold would mean that the agent's commands get them. So nothing is assumed. Every
Windlass lists the keys it takes in its answer to `initialize` (`agentCapabilities._meta.windlass.openMeta`),
and the platform goes by that list: a key is sent only to an engine that names it, and a turn that was
handed a variable to withhold fails before a session is opened should its engine not name `withholdEnv`.
What a turn's Windlass is handed has to be decided before it starts, so the first turn in a sandbox on a
server starts an engine there for that question alone (`Windlass.features`), and the answer is kept for that
sandbox (for the 500 sandboxes the server used last; one it forgot is asked again). With an older Windlass a session works as it did: its commands find the home
read-only, and its repository's secrets reach what Windlass's rule alone allows ("A repository's secrets").
The same list says whether a Windlass takes its user's checks as required checks (`requiredChecks`), and
one that does not is handed them as before ("A repository's checks").

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
replaced. The one command that is not a sign-in's, `windlass --models` ("Models"), goes the same way with an
access token's file in the directory in place of the sign-in's. There are two runners:

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
until that token expires, within the hour, and then ends asking for a sign-in; it is given no new one. On
a user's own machine its runner removes them, when it is connected at that moment ("Machines of your
own" says what holds for one that is not).

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

## Models

The models a user can pick are no fact of the deployment: they are what that user's ChatGPT plan offers.
Windlass can say what an account offers (`windlass --models`; over ACP, `_windlass/models`), and since each
user's sign-in is held by the platform ("Sign-ins"), the platform asks for each user
(`server/src/account-models.ts`).

- **How Windlass is asked.** `windlass --models --json`, run by the same runner as the sign-in commands and
  outside any sandbox. It prints one JSON object on a line for each model: `id`, `description`, `efforts`
  (the reasoning efforts that model accepts; none for a model that takes no effort) and `isDefault` (the
  model a session starts on when none is named). It runs on no sign-in: the user's actor fetches an access
  token as it does for a turn, and the runner hands it to Windlass as a turn's is, in a file that
  `WINDLASS_ACCESS_TOKEN_FILE` names (mode 0600, in a private directory that holds nothing else and is
  removed when the command has ended, however it ended). So this command refreshes nothing, and the token is
  neither logged nor stored. The lines are read strictly: one that is no model, or no line at all, makes
  the whole answer a failure, and the table Windlass prints for people is never read.
- **Where it is kept.** In the user's `user` actor, one row: the models, the efforts of each, the default,
  when it was read, and the generation of the sign-in it was read with. The actor is the cache, so every
  server answers the same and none keeps a list of its own.
- **When Windlass is asked.** When somebody asks for the list (`user.models`, or a check below) and the row
  is older than an hour, or there is none. Never on a schedule and never for a user who asks nothing: a
  listing is one request to the provider that its user caused. Whoever asks while a listing runs waits for
  that one, so one page that asks from three components causes one request. Nobody waits longer than five
  seconds: past that the answer is made from what is kept, and the listing goes on and is stored for the
  next one who asks. The command itself is stopped after five seconds. A listing that failed is logged
  (`[wlp] models.list_failed uid=...`, with Windlass's own reason and never the token) and not tried again
  for a minute.
- **What is answered without it.** `ModelList.source` says whose list an answer is. `account`: the plan's,
  with the time it was read; an old one is served on while a listing fails, since a stale list is better
  than none. Anything else is the platform's stand-in (`STAND_IN_MODELS`: three names with the efforts
  `windlass --effort` knows), and says why it stands in: `demo`, the demo's scripted model answers under
  any name, and Windlass is never asked for a demo user; `signed-out`, there is no ChatGPT sign-in to list
  with; `unavailable`, the plan's list could not be read and none is kept. The stand-in is the one fixed
  list left, and it is not a list of record: a plan may lack a model named in it, and Windlass then says so
  when the turn starts.
- **The list and its sign-in.** A row is the user's list only while the generation in it is that of their
  sign-in, which counts up whenever a sign-in is adopted or forgotten. So after a sign-out the answer is
  the stand-in at once, and the row is removed; after a new sign-in the plan is listed again. A listing
  that ends after its sign-in was replaced or forgotten is neither stored nor answered. Signing in as
  another account is another user, with an actor of their own.
- **Where it is used.** The launch form, the composer's model and effort pickers, and the defaults on the
  Settings and repository pages all read `user.models`, and each says in one quiet line whose list it is
  ("The models of your ChatGPT plan, as read at 14:02 UTC.", or "A stand-in list: ..." with the reason).
  The efforts offered are the chosen model's. The server holds a choice against the same list: a session
  is created on one of the user's models (`bad_model` otherwise), a default is saved for one, and a prompt
  that names a model or an effort is checked against the list and against the efforts of the model the
  turn runs on (`bad_effort`: "The effort for gpt-6-luna must be one of: low, medium"). A prompt that names
  neither asks nothing. A session keeps the model it has when the list no longer has it; of such a model
  the platform says nothing and Windlass decides.

```sh
cd server && npx tsx ../scripts/models-check.ts   # the list's rules, and the real `windlass --models` against a stand-in for the provider's endpoint
```

The web app's mock (`?mock=1`) has a plan of three models with different efforts, one of which takes none;
`?mock=1&models=unavailable` plays a user whose plan could not be read, and the demo sign-in has the
stand-in.

## Running on several servers

Every server is one Rivet node. With `RIVET_ENDPOINT` set it starts no engine of its own: it opens an outbound
connection to the one engine all servers share, and that engine places each actor on one of them, wakes it on
another when its server stops, keeps every actor's SQLite data and runs every actor's schedule. Nothing of a
user or a session is kept on a server. Browsers reach the actors through the engine's gateway, never through a
server, and so do the machines' runners once they are paired. A server's own port serves `GET /platform/info`,
`GET /platform/connection`, `/health`, GitHub's callback (`GET /github/callback`), the three routes a
machine's runner calls (`POST /runner/pair`, `POST /runner/pair/poll`, `POST /runner/connection`) and the
API (`POST /api/items`, `GET /api/items/<id>`), and any server answers each.

What every server needs, the same on all of them:

| Variable | Value |
|---|---|
| `RIVET_ENDPOINT` | `https://<namespace>:<token>@<engine host>`: the engine as the server reaches it, the namespace the actors live in, and the token a node joins with. `RIVET_NAMESPACE` and `RIVET_TOKEN` may carry the last two instead. A Rivet Cloud cluster sets these on its node itself |
| `RIVET_POOL` | the node pool to join (default `default`); the engine refuses a node whose pool does not exist |
| `RIVET_NODE_VERSION` | a number that goes up with every deploy, so that new and woken actors go to the newest servers |
| `NODE_ENV` | `production`: RivetKit then never starts an engine of its own |
| `WLP_SECRET` | one secret, at least 16 characters (`openssl rand -hex 32`), the same on every server: a token one server signs must pass on all. A server with `RIVET_ENDPOINT` and no `WLP_SECRET` stops with `[wlp] WLP_SECRET is not set: ...` and nothing else |
| `WLP_SANDBOX` | `e2b`. Docker sandboxes exist on the machine that made them, and a session's actor can wake on any server, so the Docker layer only works with one server |
| `WLP_WEB_ORIGINS` | the web app's address |
| `WLP_PUBLIC_ENDPOINT` | the engine's address for browsers, with no namespace and no token in it. It need not be the address in `RIVET_ENDPOINT`: on a cluster that one is internal to the node |
| `RIVET_ADMIN_TOKEN` | the engine's admin token, a secret, where the engine asks browsers for a token ("What browsers connect with" below). With it set, a server without `WLP_PUBLIC_ENDPOINT` stops with `[wlp] WLP_PUBLIC_ENDPOINT is not set: ...` |
| `WLP_CONNECTION_TOKEN_TTL_MS` | optional: how long a browser's token lasts (default one hour, at most 24) |
| `WLP_WINDLASS_BIN` | a Windlass executable on the server, for the sign-in commands ("Sign-ins"). `server/Dockerfile` puts one at `/usr/local/bin/windlass` and sets this |
| `WLP_SIGNIN_KEY` | optional; when set, the same on every server: what the key that encrypts sign-ins is derived from, in place of `WLP_SECRET` |
| `WLP_DEMO`, `WLP_TURN_TIMEOUT_MS`, `WLP_QUESTION_TIMEOUT_MS`, `WLP_IDLE_SUSPEND_MS`, `WLP_IDLE_DESTROY_MS` | the same values everywhere: a session's limits are applied by whichever server holds its actor |
| `WLP_DAILY_SANDBOX_SECONDS`, `WLP_MAX_KEPT_SANDBOXES`, `WLP_USAGE_HOLD_SECONDS` | the same values everywhere: a user's limits are applied by whichever server holds their `user` actor ("Usage and limits") |
| `WLP_FACTORY_*` | the same values everywhere: the limits of work items and of a user's running turns are applied by whichever server holds the user's actor ("Work items") |
| `WLP_MACHINES`, `WLP_PUBLIC_URL`, `WLP_RUNNER_IMAGE` | the same values everywhere, where users may pair machines of their own ("Machines of your own"). `WLP_PUBLIC_URL` is required then: it is the address runners are given |
| `WLP_HTTP_PORT` or `PORT` | the port the load balancer sends `/platform/info` to |

**What browsers connect with.** An engine that is shared is one that checks who connects. A Rivet Cloud
cluster is such an engine, run for one customer, and it has one credential: an admin token, which may do
everything in every namespace and so stays on the servers. It has none of the fixed tokens of a Rivet Cloud
project (`pk_...`, `sk_...`, `ck_...`); those are another product's. What a browser holds is a scoped token: a
JWT the engine issues when it is asked with the admin token, good for one namespace, for the operations it
names, and for a limited time.

The servers issue it. `GET /platform/connection`, under the same origin check as `/platform/info`, answers
with the engine's address for browsers (`WLP_PUBLIC_ENDPOINT`), the namespace, and a token with its expiry. The
token may create, list and read actors and call them through the gateway (`actor`: `create`, `list`, `read`;
`actor_gateway`: `read`, `create`), which is what the web app does, and nothing else: no deleting, no nodes, no
pools. It says only that its holder is a client of this deployment. Who the user is, and what is theirs, is
still decided by the platform's own token in every actor. A server asks the engine once and hands the same
token to every browser until half of its life is gone, so the engine is asked about twice an hour by each
server, and a browser always gets one that is good for half an hour or more. Each server keeps a token of its
own; all of them are good at the one engine.

The web app is therefore built with one address, `VITE_WLP_API`: the address in front of the servers' HTTP
port. It asks there for its connection when it starts, and has no token and no engine address built in. When
its token runs out it asks again: the next request or reconnect is made with the new one, and nothing is
reloaded. A feed that is open stays open, since the engine checks a token when a connection is opened and not
afterwards. While the servers cannot be reached to renew it, a feed shows that it is reconnecting and goes on
when they can.

Shared by all servers: the engine with the actors' data and schedules, `WLP_SECRET`, the admin token, and the
sandbox provider. Kept by each server for itself, and rebuilt when it is asked again: the cached platform
information, the token it hands browsers, and the sandbox layer's own caches. Still on one machine: the Docker
layer. The ChatGPT sign-ins are not: they are in
the users' actors, and every server needs `WLP_WINDLASS_BIN` (and the same `WLP_SIGNIN_KEY`, when it is set) to
run Windlass's sign-in commands ("Sign-ins").

**On a Rivet Cloud cluster.** A cluster is an engine run by Rivet with nodes run by Rivet: the server is built
into an image and runs on the cluster's own node, which sets the connection and pool variables itself. From the
repository root:

```sh
rivet cluster secret set WLP_SECRET           # prompts for the value
rivet cluster secret set RIVET_ADMIN_TOKEN    # the cluster's admin token
rivet cluster secret set E2B_API_KEY          # and whatever else the E2B layer reads
server/stage-windlass.sh                      # the Windlass builds the image takes its own from
rivet deploy --cluster <cluster> --dockerfile server/Dockerfile --build-context . \
  --secret WLP_SECRET --secret RIVET_ADMIN_TOKEN --secret E2B_API_KEY \
  --env WLP_SANDBOX=e2b --env WLP_WEB_ORIGINS=https://<name>.onrivet.dev \
  --env WLP_PUBLIC_ENDPOINT=https://<name>-api.onrivet.dev
```

To let users pair machines of their own, add `--env WLP_MACHINES=1 --env WLP_PUBLIC_URL=https://<name>.onrivet.dev`,
and `--env WLP_RUNNER_IMAGE=<name>@sha256:<digest>` once a runner image is published. With `WLP_MACHINES=1`
and no `WLP_PUBLIC_URL`, a server on a remote engine does not start.

The CLI builds the image for linux/amd64 (on an arm64 machine too: the image's build runs nothing of the other
architecture) and prints the pool's public address, `https://<name>.onrivet.dev`, which serves the port in
`PORT`. The image holds the web app as well and serves it there (`WLP_WEB_DIR`, `server/src/web.ts`), so that
address is the platform: the web app is built with nothing set and asks the address it was loaded from, and
`WLP_WEB_ORIGINS` names that same address. A web app hosted elsewhere is built with `VITE_WLP_API` set to it. The
cluster's engine answers browsers at `https://<name>-api.onrivet.dev`, which is `WLP_PUBLIC_ENDPOINT`; the
address the node itself is given in `RIVET_ENDPOINT` is an internal one. The server asks the engine for its
first token when it starts, and says so if it is refused (`[wlp] WARNING: Browsers cannot connect: ...`). There
is no Docker on a cluster's node, so `WLP_SANDBOX=e2b` is required there. The cluster rolls its pool from
one build to the next itself; if the server says `node version defaulted` when it starts there, add
`--env RIVET_NODE_VERSION=<n>`, a number that goes up with every deploy.

**On servers of your own.** Each runs the same image, or `cd server && npx tsx src/index.ts`, with the
variables above, behind a load balancer for port 6440. The Rivet docs describe such nodes joining an engine by
`RIVET_ENDPOINT` and a secret token; whether a Rivet Cloud cluster accepts nodes of your own beside its hosted
one, they do not say. An engine of your own that has an admin token (`auth.admin_token`) is told to the servers
as a cluster's is, with `RIVET_ADMIN_TOKEN` and `WLP_PUBLIC_ENDPOINT`; one that lets everybody in needs neither,
and the web app is then built with its address in `VITE_WLP_ENDPOINT`.

## E2B

With `WLP_SANDBOX=e2b` a session's sandbox is a microVM at [E2B](https://e2b.dev) instead of a container on the
server's machine, so any server of a deployment reaches any session's sandbox. A deployment has one provider:
a server on E2B offers the E2B profiles and no Docker profile of its own (a user's machine offers its own
two, "Machines of your own"). `scripts/e2b-check.ts` tries it against the real
service; it first passed there on 2026-11-15.

```sh
E2B_API_KEY=e2b_... sandbox/e2b/build.sh                            # builds the template windlass-platform-sandbox at E2B, with the released x86_64 Windlass
cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-check.ts    # one sandbox, one scripted turn, about two minutes
WLP_SANDBOX=e2b E2B_API_KEY=e2b_... WLP_WINDLASS_BIN=/path/to/windlass npx tsx src/index.ts
```

`sandbox/e2b/build.sh --print` shows what E2B would be asked to build and needs no key. The template is made
from the Docker image's own `sandbox/Dockerfile`, so a microVM has what a container has: the user `agent`,
`/workspace`, Windlass's data directory, `wlp-run`, git, bubblewrap and Windlass. A server on E2B needs no
Docker: Windlass's sign-in commands run from `WLP_WINDLASS_BIN`, an executable for the server's own machine.
E2B's SDK (`e2b` 2.63.0, loaded only by a server on E2B) needs Node 22.19 or later.

- **What the profile promises.** Whether Windlass's bubblewrap sandbox works inside a deployment's microVMs is
  for the check to show (it worked in the template on 2026-11-15), so by default the profile promises nothing
  of it: commands may have network and may read the session's access token. Windlass runs with
  `--approval auto` and probes bubblewrap itself: where the probe passes it sandboxes commands, where it fails
  it asks before every command. The check prints which (`ANSWER:`).
  If bubblewrap works, `WLP_E2B_WINDLASS_SANDBOX=1` makes the profile promise what the first Docker profile
  promises, and every new sandbox is held to it: one in which the probe fails is removed and not handed out.
- **A second profile: E2B, microVM only** (`e2b-open`), offered only where the servers run with
  `WLP_E2B_OPEN_PROFILE=1`; without it the picker lists it as not available, and a server refuses to launch a
  session with it whatever the browser sends. Windlass runs with `--approval full` and sandboxes no command:
  commands run directly in the microVM, with its network and a writable home directory (package installs,
  tools that write `~/.config`), and nothing asks first. What that gives up: a command can reach any host, and
  can read the session's access token, which is in a file in the microVM while a turn runs (the sign-in is
  never in the microVM, in this profile too). One thing stays: once something from the web or an MCP server is
  in the conversation, Windlass's taint rule sandboxes commands again and asks before network or a write
  outside the workspace. A sandboxed command then finds a home of the session's own ("Sandboxes" above): what
  the commands before it left in the home is read-only there, and what it adds is kept apart for the session.
  The user chooses per session; the E2B profile above stays the picker's default. A
  sandbox's profile is in its metadata (`wlp_profile`), so every server runs a session's Windlass the same way;
  sessions launched with `e2b-open` keep it after the flag is turned off, and only new ones are refused.
- **A turn** is the same process as in a container, `wlp-run exec <tag> windlass acp`, started through E2B's
  command API; the access token file is written the same way, the token on the command's standard input.
- **Windlass's data directory is on the microVM's own disk**, not on a volume (E2B's volumes are a private beta
  in which file locks can hang, and Windlass keeps SQLite databases there). A session's Windlass session lives
  and ends with its sandbox, and no session sees another's files, also not the token file of the same user's
  other turn. A pause keeps it. When a sandbox is gone (killed, or lost), the session gets a new one with an
  empty workspace. With a bucket configured, the copy of Windlass's session is put into the new sandbox and
  the agent goes on where it was ("The agent's memory outlives its sandbox" below); without one it starts a
  new Windlass session, and the timeline says so. On Docker the data directory is a volume of the user's and
  outlives a sandbox.

Using little of E2B is built in. The free Hobby plan runs on a one-time credit of $100 and allows 10 sandboxes
at once and one hour of running without a pause; every default is well inside that.

| What | How | Default |
|---|---|---|
| Size of a sandbox | the template's, set when it is built: `WLP_E2B_CPU`, `WLP_E2B_MEMORY_MB` for `sandbox/e2b/build.sh` | 1 vCPU, 1024 MiB |
| Sandboxes running at once | `WLP_E2B_MAX_RUNNING`, counted from E2B's own list of the deployment's running sandboxes before one is created or resumed, and again after, so it holds across servers. At the cap the user reads: "This deployment runs at most 3 sandboxes at the same time, and all of them are in use. Try again in a few minutes; an agent's sandbox is freed shortly after its turn has ended." A work item's turn is not refused at the cap: it waits, and is tried again after 30 seconds, then twice as long each time up to five minutes ("Work items") | 3 |
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
being used (`WLP_IDLE_DESTROY_MS`) or by its user on the Usage page ("Usage and limits"), or `e2b-cleanup.ts`
removes it; opening a session's changes in the browser resumes its sandbox for the length of the idle timeout;
and a turn whose command stream to E2B breaks ends as a failed turn, though the sandbox goes on until its
timeout.

## Machines of your own

With `WLP_MACHINES=1` a user can pair a Linux machine of their own that has Docker, and launch agents on it.
A small program on that machine, the runner, connects out to the platform, and makes and runs the
sessions' containers on the machine's own Docker. Everything else stays with the platform: the session's
actor, the turn's conversation with Windlass, questions, secrets, the GitHub App, the checks' record and the
timeline. Nothing on the machine needs to be reachable from outside. A session's place is chosen at launch
("Where it runs" in the launch form, `place` in `createSession`) and kept for its whole life.

- **Pairing.** The Machines page (`/machines`) shows the command that starts the runner:

  ```sh
  docker run -d --name windlass-runner --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v windlass-runner:/var/lib/windlass-runner \
    <WLP_RUNNER_IMAGE> --platform <WLP_PUBLIC_URL>
  ```

  For rootless Docker the socket to mount is `$XDG_RUNTIME_DIR/docker.sock`. The runner makes an Ed25519
  key pair, keeps the private key in its volume, sends the public key with its machine's host name,
  system, architecture and its own version to `POST /runner/pair`, and prints a code in
  `docker logs windlass-runner`: "Open https://.../machines/add and enter XXXX-XXXX". The user types the
  code on that page (case, spaces and dashes do not matter). The page then shows what the machine says
  about itself, its name, OS, architecture and runner version, says that nobody has checked these, and
  says what the machine will receive: the repository's files, its saved secrets and a ChatGPT token for
  each turn that lasts about an hour. Only after "Connect" is the machine paired. The runner, which asks
  `POST /runner/pair/poll` meanwhile, then prints whose account it joined ("Paired with ada. If that is not
  you, run `windlass-runner pair` again."; "an account without a GitHub login" where GitHub is not
  connected) and connects. A code lasts ten minutes and belongs to the first account that types it; for
  any other it is not found. A runner whose code expired waits and says so: "The pairing code expired, so
  restart the container or run `windlass-runner pair` to get a new code." To update the runner, the same
  command after `docker rm -f windlass-runner`: the volume keeps the key, so the machine stays paired.
- **Launching on it.** The launch form lists the user's machines beside the platform's own sandboxes, each
  with its state. A machine whose runner has not reported yet cannot be chosen ("“nas” has not connected
  yet. Start its runner, and once the Machines page shows it online, start the agent again."), nor one
  whose runner is older than the platform takes ("The runner on “nas” is older than this platform takes:
  update it to 0.1.0 or later, then start the agent again."). A machine offers the two Docker profiles,
  `docker-windlass-sandbox` and `docker-hardened`, as its runner last reported them: the first only where
  bubblewrap starts in a container there.
- **What the platform keeps.** The machine's public key, what it said of itself when it was paired, when
  its runner was last heard from, and the runner's last report: whether Docker answers, whether bubblewrap
  starts in a sandbox there, the free disk space, its sandboxes, and the caps its owner set, where any is
  set. The private key never leaves the machine. The runner's request for a connection is signed with it,
  its control socket proves it by signing a challenge, and a session's socket carries a ticket the session
  made for it, through the machine's control socket, which is good once and for one minute and is signed
  with the machine's key too.
- **What the runner does.** What the server's Docker layer does, on the machine's Docker, and only what its
  protocol names: it makes a session's container, runs the platform's commands in it, starts and stops
  it, and removes it when asked. It runs one sandbox image, pinned by digest when the runner is built, and
  never pulls another. It touches only containers it labelled for its own machine
  (`dev.windlass-platform.machine=<machine id>`) and one data volume of its own,
  `wlp-machine-<machine id>`, which is Windlass's data directory for the machine's sessions, as the user's
  volume is on Docker. Each container has the limits a hosted Docker sandbox has (1.5 CPUs, 1536 MiB of
  memory, 512 processes, no capabilities), and none is made with less than 5 GB of free disk. It stops a
  sandbox that has not been used for the idle time the platform names (`WLP_IDLE_SUSPEND_MS`), never while
  a command runs in it or the session's socket is connected, and it never removes one by itself.
- **What the runner cannot do, and what the platform cannot do.** The runner cannot start a container of
  another image, run anything on the machine outside the containers it made, touch a container or a volume
  it did not make, or reach a session that did not hand it a ticket. It holds no sign-in: each turn is
  handed a ChatGPT access token in a file, as on every place. The platform, for its part, cannot reach the
  machine except through its runner, and does not control it: whoever runs the machine can change what
  runs there and what it reports. The launch form, the profiles and a pull request's section say so.
- **No limit unless its owner sets one.** The platform counts nothing of a machine: its sandboxes take no
  sandbox time and no place among the kept sandboxes, have no price, and its turns are not among the
  user's agents working at once: one rule, `hostedLimitsApply` (`server/src/usage.ts`), holds a session
  to the daily time, the kept sandboxes and the running agents, and it holds only a hosted one.
  What bounds a machine is the machine: its runner takes `--max-running` and `--max-sandboxes`, with no
  default, after the command above, and a turn that would pass one ends with "This machine has reached its
  own limit on kept sandboxes, set by --max-sandboxes." (or on running sandboxes, by `--max-running`). The
  Machines page shows what is in force under "Sandbox limit", "no limit" or the numbers, and says that a
  limit is set on the machine, not there.
  A sandbox there is not removed after `WLP_IDLE_DESTROY_MS` either: it goes with its agent, with the
  machine's sandboxes, or by `prune`.
- **When the link drops.** One control socket per machine to its `machine` actor, and one socket per
  session to that session's actor while the session needs its machine, both through the engine's gateway.
  A dropped socket does not end a turn: both ends keep what the other has not acknowledged, and the turn
  goes on when the runner is back, with every event once. Meanwhile the session says "Your machine "nas"
  is not answering since 14:02. The turn goes on when it is back, or stops at 14:12." The banner follows
  the machine while the page is open: the session pushes a `machine` event to it each time what it found
  changes (answering, not answering, offline, removed). Ten minutes without
  the runner (`RUNNER_GRACE_MS`) end that conversation, and what was outstanding in it fails. An operation
  that is the same done twice is asked once more after a lost conversation, `create` included: the runner
  answers a second `create` for a session with the sandbox that session already has, so a lost answer
  never makes a second sandbox.
- **When the runner restarts.** Its conversations with the sessions are in its process's memory, so a turn
  running then ends, not as done; the next turn stops what the old one left running in the sandbox, and
  runs.
- **When a server restarts.** The session goes to sleep as any does ("When a server stops") and its
  conversation with the runner ends with it; the next turn, on whichever server, opens a new one. The
  session does not suspend a machine's sandbox on its way to sleep (`[wlp] sandbox.suspend_skipped`): the
  runner stops it after the idle time.
- **When the machine is offline.** An agent can be launched on it, and the form says that a prompt sent
  before the machine is back fails. A prompt is not queued: it fails with "Your machine "nas" is offline.
  The agent's files are there; send the prompt again when it is back.", at once when the machine's actor
  knows it is offline, and after 15 seconds when the runner does not answer. The banner above the
  composer says since when the machine is offline.
- **When the machine is removed.** "Remove…" on the Machines page deletes its key: the runner's control
  socket is refused at once, and the runner forgets its key, stops its sandboxes and waits to be paired
  again ("This machine was removed from its account, so run `windlass-runner pair` to pair it again with a
  new key."). With "Also remove the agents' sandboxes on it", it removes them and its data volume instead,
  at once when it is connected and when it next connects when not. A turn running on the machine ends
  within seconds: the timeline closes it with the sentence of an engine that stopped in the middle of the
  turn, not with the removal; from then on the banner says "This agent's machine was removed. Its files
  were there. Start a new agent to go on.", a prompt is answered with the same sentence, and the agents
  keep their timelines. If the machine's control connection was already down when it was removed, its
  runner learns of the removal only when it next connects, at most a minute after its network is back, and
  serves the sessions it already has until then. Deleting an agent on a machine records the removal of its sandbox with the
  machine's actor, and the runner removes it, at once when it is connected and when it next connects when
  not. A delete whose removal could not be recorded is refused (`machine_unreachable`: "The agent could
  not be deleted: its machine's record of the sandbox to remove could not be written. Try again in a
  moment."), and the agent stays listed until a delete goes through; once the removal is recorded, nothing
  the runner answers holds the delete back.
- **Not seen for 90 days.** A machine whose runner has not been heard from for 90 days is removed with its
  key (`MACHINE_EXPIRY_MS`); its agents keep their timelines, and its sandboxes are left where they are.
- **Forgetting the ChatGPT sign-in.** Each machine whose runner is connected at that moment is told, and
  its runner removes the token files of running turns from its data volume. A machine that is offline then
  is not told, and is not told later: the platform keeps no logout for it. A token in a file there, which a
  turn cut off by the machine going away can leave, lasts about an hour from when it was handed out, and
  whoever reads it cannot renew it. To remove such files sooner, the machine's owner removes the runner's
  sandboxes and its data volume there with `prune`. It waits for the lock the running runner holds, so the
  runner is stopped first, and started again afterwards:

  ```sh
  docker stop windlass-runner
  docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock \
    -v windlass-runner:/var/lib/windlass-runner <WLP_RUNNER_IMAGE> prune
  docker start windlass-runner
  ```
- **Saved secrets.** A repository's and the account's saved secrets reach a machine's agents only while
  "Send saved secrets to this machine" is on, which it is for a new machine; a change holds from each
  agent's next turn.
- **Pull requests, and the machine's name.** The session keeps its machine's name from the launch, so it
  can name the machine while the machine is offline. A pull request of a session on a machine keeps its
  "What was verified" section, with one more line: "These checks ran on ada's own machine, “nas”; this is
  what that machine reported." And the question about a project's MCP server says where the server would
  run: "It runs in this session's container on your machine "nas", with its network, ..."
- **The pairing limits.** A user can have three machines paired at once (`MAX_MACHINES`): each machine
  that is connected keeps an actor awake on the platform, and this is what bounds that cost for one
  account. A user can look up five codes in ten minutes. And the platform's routes see no client address
  they could trust, so the pairings that are started are limited by the machine key that starts them,
  three in ten minutes, and in 64 groups of sixteen that a key cannot choose. That bounds how many pairing
  attempts anyone can leave open on the deployment; someone who makes many keys can use up the starts for
  ten minutes, and the runners that are paired already are not affected.
- **What the runner reports on the machine.** `windlass-runner status` (in the container:
  `docker exec windlass-runner windlass-runner status`) says whether it is connected, the caps in force and
  the sandboxes and data volume of its pairings; `windlass-runner log` is its own record of what it was
  asked.

| Variable | Effect |
|---|---|
| `WLP_MACHINES` | `1`: every user of the deployment may pair machines. Off (the default): the runner's routes answer 404, the machine actions refuse with `machines_off`, and platform info has no `machines`. The machines and their tables stay, so turning it off and on again loses nothing |
| `WLP_PUBLIC_URL` | the platform's address as a machine outside reaches it: an `https://` origin, or `http://` on a loopback address, with no path. Required with `WLP_MACHINES=1` and a remote engine; with the local one, `http://localhost:<WLP_HTTP_PORT>` |
| `WLP_RUNNER_IMAGE` | the runner image the Machines page tells users to start, pinned by digest (`<name>@sha256:<64 hex>`). Unset: the page says that it cannot be installed yet. Set to anything else, the server does not start |

What is not there yet. No runner image is published, so the page has no command to copy until one is:
`scripts/runner-build.sh [<sandbox image pin>]` builds `windlass-runner:dev` for the machine it runs on,
from a local sandbox image (`windlass-platform-sandbox:latest` by default) whose id it pins, and with
`WLP_RUNNER_PLATFORMS=linux/amd64,linux/arm64` it writes a two-architecture OCI archive instead. A new
sandbox image means a new runner build. `docker-windlass-sandbox` is offered on a machine only where the
runner's probe found that bubblewrap starts in a container there, which is the machine's kernel's to allow;
elsewhere only `docker-hardened` is. And work items do not run on machines ("Work items").

## The agent's memory outlives its sandbox

A session has two histories. The timeline, which the user reads, is in the session's actor. What the model
remembers of the conversation is Windlass's own session, in Windlass's data directory, which on E2B is on the
sandbox's disk and goes with it: when an idle sandbox is removed after seven days, or when E2B loses one. With
a bucket configured, a copy of that data is kept outside the sandbox and put back into the one that replaces
it, so the agent continues the same Windlass session there (`session/resume`). Without a bucket nothing
changes: the agent then starts without its memory, and the timeline says so. On Docker there is nothing to
do, since the data directory is a volume that outlives every sandbox.

- **What is copied.** Windlass keeps one SQLite database per session, in WAL mode
  (`sessions/<id>.db`), and that file is all a `session/resume` needs, with its write-ahead log
  (`.db-wal`) when a Windlass that was killed left one: without it the database opens and has silently lost
  the last turn. Copied with them are the media the messages refer to (`blobs/`) and Windlass's notes
  (`memory/`). Everything else stays in the sandbox, because only what is named is copied: the turn's access
  token file, anything of a sign-in, the wake-ups' database (it holds webhook secrets), locks, caches, and the
  snapshots of the workspace. `server/src/sandbox/backup.ts` has the whole list and the reasons.
- **When.** After every turn in which Windlass ran, while the turn is being closed: its process is gone by
  then, so nothing has the files open and a plain `tar` of them is whole. It is one object per session,
  `sessions/<uid>/<session>.tgz`, replaced each time. A restore happens once, before the first turn in a
  sandbox that was made in place of a lost one.
- **The bytes never pass through a server.** The server signs a link, good for five minutes, for one
  object and for one method, and for an upload for exactly the size the archive has. The sandbox's own
  `curl` uses it, in a command the platform runs beside Windlass, not under it (Windlass's bubblewrap sandbox
  gives the agent's commands no network). The link reaches the sandbox on the command's standard input and
  is in no command line, no environment, no file and no log. The server itself sends two small requests a
  turn: one to learn the object's size after an upload, and one to remove it when a session is deleted.
- **The session's record.** The actor keeps the archive's size, its SHA-256, when it was saved and after
  which turn. A restore checks the download against the size and the hash before anything is unpacked, and
  unpacks only an archive that holds nothing but what a copy holds.
- **What the user sees.** Nothing for a save. For a restore one line, "Restored the agent's memory of the
  conversation into the new sandbox." When there is no copy, or it cannot be restored, the line of before:
  "The agent's memory of the conversation went with the old sandbox, so it starts this turn without it."
- **A save that fails is not retried by itself.** `curl` tries a transfer again twice; after that the save
  is given up and logged (`[wlp] backup.save_failed`). The next turn's save copies the whole session again,
  and trying in between would mean starting a sandbox that was suspended so as to cost nothing. The user is
  told only if it comes to matter: if the sandbox is lost before a save works, the restore says "...
  without the last turn: no copy of it could be saved."
- **The size limit.** An archive larger than `WLP_BACKUP_MAX_BYTES` (64 MiB) is not uploaded. The timeline
  says so once ("The agent's memory of the conversation has grown to 70 MB, and the platform keeps a copy of
  at most 64 MB, so it is no longer copied out of the sandbox. ..."), and the last copy that fitted stays.
- **Deleting a session deletes its object**, after its sandbox, which is what uploads. The session tries
  three times; an object that is still there then is handed to the user's `user` actor
  (`[wlp] backup.remove_deferred`), which outlives the session and tries again on its durable schedule, 1,
  2, 4, ... 128 minutes apart: eight more tries over about four hours and a quarter, across restarts. An
  object the store no longer has counts as removed. After the last try the object is named in the log
  (`[wlp] backup.remove_failed uid=... session=... object=...`), for whoever looks after the bucket.
- **Who can read a copy.** It holds the conversation as Windlass has it: the prompts, the model's answers,
  the tool calls and their output. It is not encrypted by the platform. Whoever holds the bucket's access key
  can read every copy, as can the store's operator; a sandbox can reach its own session's object and no
  other, for the minutes a link lasts. The workspace's files are not in it.

The store is anything that speaks the S3 protocol; only presigned PUT and GET, HEAD and DELETE are used, so
changing the provider is changing the settings. For Cloudflare R2: a bucket of its own, and an API token
with "Object Read & Write" on that bucket only.

| Variable | Value |
|---|---|
| `WLP_BUCKET_ENDPOINT` | the store's S3 endpoint without the bucket: for R2, `https://<account id>.r2.cloudflarestorage.com` |
| `WLP_BUCKET_NAME` | the bucket |
| `WLP_BUCKET_ACCESS_KEY_ID`, `WLP_BUCKET_SECRET_ACCESS_KEY` | an access key that may read, write and delete objects in that bucket. The second is a secret |
| `WLP_BUCKET_REGION` | optional: the region the signatures name (default `auto`, which is R2's) |
| `WLP_BUCKET_STYLE` | optional: `path` (default) or `virtual`, where the bucket's name goes in an address |
| `WLP_BUCKET_PREFIX` | optional: put before every key, for a bucket that is shared |
| `WLP_BACKUP_MAX_BYTES` | optional: the largest archive that is kept (default 67108864) |

They are the same on every server. On a Rivet Cloud cluster the endpoint, the bucket's name and the two
halves of the access key are set as secrets (`rivet cluster secret set WLP_BUCKET_ENDPOINT`, and so on, with
a `--secret` for each on `rivet deploy`). With none of them set the feature is off; with only some, it is off
and the server says which are missing when it starts.

```sh
cd server && npx tsx ../scripts/backup-check.ts                     # the seam and the backups: no network, no Docker
cd server && flock /tmp/wlp-test.lock npx tsx ../scripts/backup-check.ts --bucket --docker
                                                                    # a real bucket, and a real Windlass in local containers
cd server && E2B_API_KEY=e2b_... npx tsx ../scripts/e2b-backup-check.ts
                                                                    # two E2B sandboxes, one after the other, for under half a minute
```

The last two read the bucket's settings from the variables above, or from `R2_ENDPOINT`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`; they write under a prefix of their own and remove it. Measured
from an E2B sandbox to R2, for a session of one turn (24 kB): a save takes 1.3 seconds, a restore one.

## GitHub

With a GitHub App of its own, a deployment lets a user connect GitHub, launch an agent on one of their own
repositories, private ones included, and get the work back as a pull request. Without one the web app shows
nothing of this, and a repository is a public address pasted into the launch form, as before.

- **Connecting.** "Connect GitHub" (the account menu, or the launch form) sends the browser to GitHub, where the
  user authorizes the app; with the app installed nowhere they can reach, GitHub's installation page follows,
  where they pick an account and its repositories. GitHub sends the browser back to `GET /github/callback` on a
  server's own port, with a code. The server exchanges it, asks GitHub who this is and which installations of
  the app they can reach, deletes the token it was given, and sends the browser on to the web app, which
  hands what GitHub confirmed to the user's `user` actor. That is the connection: a GitHub login and the
  accounts the app is installed on. Disconnecting forgets it; the app stays installed at GitHub, which is the
  account owner's to change.
- **No credential of the user's is kept.** Not a token, not a refresh token. What the platform does at GitHub
  later, it does as the app's installation.
- **Launching.** A connected user searches their repositories in the launch form and picks a branch (the
  default one is chosen). The session records what it was launched on, and its sandbox gets a clone.
- **A pull request.** In a session's panel, "Open pull request": the platform commits what is uncommitted with
  a message the user reads and edits first, pushes a branch named for the session
  (`windlass/<its title>-<the end of its id>`), and opens the pull request through GitHub's API. After that the
  panel shows the pull request with its number and state, and "Push changes" updates the same branch. The
  timeline gets one line for each ("Opened pull request #12 in acme/harbor from windlass/fix-the-light-3f9a2c,
  with 3 files."). The agent's own git has nothing to push with, in any case: what it can do is ask the
  platform for the same ("The agent asks to publish").
  The pull request's description ends with a section the platform writes, and writes again with every
  push: which checks ran before the agent's turn was called done, whose they are, how each ended, and
  what in the changes is worth a look ("What a pull request shows was verified").
  A commit is made in the GitHub user's name (`<id>+<login>@users.noreply.github.com`); the pull request is
  the app's.

### The GitHub App

Register one at GitHub (Settings, Developer settings, GitHub Apps, New GitHub App), for the address the
platform is served at, `https://<name>.onrivet.dev` below:

| Setting | Value |
|---|---|
| GitHub App name | any; its address `https://github.com/apps/<slug>` gives `WLP_GITHUB_APP_SLUG` |
| Homepage URL | `https://<name>.onrivet.dev` |
| Callback URL | `https://<name>.onrivet.dev/github/callback`, and no other |
| Expire user authorization tokens | selected |
| Request user authorization (OAuth) during installation | selected. GitHub then sends the browser to the callback URL after an installation too, with a code |
| Setup URL | none. GitHub takes none while the setting above is selected |
| Enable Device Flow | not selected |
| Webhook | "Active" not selected: the platform listens to nothing |
| Repository permissions | Contents: read and write. Pull requests: read and write. Checks: read-only. Commit statuses: read-only. Actions: read-only. Metadata: read-only (GitHub adds it). Nothing else |
| Organization and account permissions | none |
| Where can this GitHub App be installed? | "Any account", for users other than the app's owner |

Then, on the app's page: note the App ID and the Client ID, generate a client secret, and generate a private
key (a `.pem` file is downloaded).

The three read-only permissions are for work items ("Work items"), which read the CI of a commit the
platform pushed: its check runs (Checks), its commit statuses (Commit statuses) and the log of a GitHub
Actions job that failed (Actions). Nothing else uses them, and everything else works without them. An app
that was registered with the first two only is changed on its page, under Permissions and events; GitHub
then asks the owner of each account the app is installed on to accept the new permissions. Until an
installation has accepted them GitHub refuses the platform its CI, and an item on that installation's
repositories is handed over without it: its verdict says that CI was not read, that the app needs read
access to Checks, Commit statuses and Actions, accepted on the installation, and that the pull request's
own page shows the checks.

| Variable | Effect |
|---|---|
| `WLP_GITHUB_APP_ID` | the App ID, a number |
| `WLP_GITHUB_APP_SLUG` | the app's name as its address has it |
| `WLP_GITHUB_CLIENT_ID` | the Client ID (`Iv23...`) |
| `WLP_GITHUB_CLIENT_SECRET` | the client secret. A secret |
| `WLP_GITHUB_PRIVATE_KEY` | the private key. A secret. The file as it is, or with `\n` for its line breaks, or in base64 (`base64 -w0 <file>.pem`), which is the form for a secret store that takes one line |
| `WLP_GITHUB_API_URL`, `WLP_GITHUB_URL` | GitHub's API and GitHub itself (defaults `https://api.github.com`, `https://github.com`); for GitHub Enterprise Server, and for the checks' stand-in |

All five of the first must be set, the same on every server. With some of them missing the feature is off and
the server says which (`[wlp] WARNING: GitHub is off: ...`). On a Rivet Cloud cluster the two secrets are
cluster secrets and the rest plain variables. A cluster's secret holds at most 1024 bytes and the key in base64
is over two thousand, so it goes in as pieces, `WLP_GITHUB_PRIVATE_KEY_1`, `_2`, ..., which the server puts
together in order:

```sh
rivet cluster secret set WLP_GITHUB_CLIENT_SECRET
base64 -w0 <file>.pem | fold -w 1000 | { n=1; while read -r piece; do
  printf %s "$piece" | rivet cluster secret set "WLP_GITHUB_PRIVATE_KEY_$n" --yes; n=$((n + 1)); done; }
rivet deploy ... --secret WLP_GITHUB_CLIENT_SECRET \
  --secret WLP_GITHUB_PRIVATE_KEY_1 --secret WLP_GITHUB_PRIVATE_KEY_2 --secret WLP_GITHUB_PRIVATE_KEY_3 \
  --env WLP_GITHUB_APP_ID=<id> --env WLP_GITHUB_APP_SLUG=<slug> --env WLP_GITHUB_CLIENT_ID=<client id>
```

### Whose installation it is

An `installation_id` in an address proves nothing: anyone can type one, and
[GitHub says so](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).
So the callback route records nothing from the address. It asks GitHub, with the token the user's own
authorization gave it, which installations that user can reach, and an installation the address names must be
among them.

What ties a connection to a platform user is a `state` the user's actor issues and the server signs
(`WLP_SECRET`): it names that user, is good for ten minutes, and the actor takes it off its list when the
callback claims it, so it works once. The callback route is reached by a browser coming from GitHub, which
carries nothing that says who is signed in to the platform, so a state alone would let someone start a
connection for their own account and have another person finish it. The route therefore records nothing
itself: it hands the browser a signed ticket, in the address's fragment, and only the `user` actor of the user
the ticket names takes it, from a caller signed in as that user, once.

### Who may do what

GitHub lists an installation for anyone who can open one of its repositories: a member of an organization,
or a collaborator on one repository of somebody's account, reaches an installation that covers more than they
may see, and the platform, acting as that installation, could read all of it. So before it lists, clones or
pushes anything for a user, the platform asks GitHub what that user may do in that repository (with the
installation's own token; no credential of the user's is needed), and does it only when GitHub says read, or,
to push, write. An installation on the connected user's own account is theirs, and is not asked about. The
launch form lists only repositories its user can read; one they can read and not push to says so.

A list has 20 seconds for all its calls to GitHub together, each call getting what is left. When they run
out, the list is what was found by then and says that GitHub was slow and some repositories may be
missing; when nothing was found, the form says that GitHub could not be reached.

### Tokens

Three credentials exist, and none is stored, logged, or put in a timeline item, an event or an error:

| Credential | Made | Good for | Where it goes |
|---|---|---|---|
| the app's JWT | signed by the server with the app's private key, for each request | nine minutes; asking GitHub for an installation token | to GitHub |
| an installation token | by GitHub, when a step needs one, for the one repository the session works on and the permissions of that step | an hour at most; one that went into a sandbox is revoked as soon as its git command has ended | see below |
| a user access token | by GitHub, for the code a user's authorization ended with | two questions (who is this, which installations can they reach), then it is deleted at GitHub | to GitHub |

| Step | Permissions of its token | Where the token is |
|---|---|---|
| listing repositories, asking what a user may do | metadata: read (the installation's repositories) | the server |
| listing branches | contents: read, metadata: read (one repository) | the server |
| cloning | contents: read, metadata: read (one repository) | the sandbox, for one `git clone`; then revoked |
| pushing | contents: write, metadata: read (one repository) | the sandbox, for one `git push`; then revoked |
| the pull request | pull requests: write, contents: read, metadata: read (one repository). Contents, because GitHub opens no pull request for a token that cannot read the two branches | the server |
| reading a commit's CI, for a work item | checks: read, statuses: read, actions: read, metadata: read (one repository), for one reading | the server. A job's log is a redirect to GitHub's short-lived storage, which is fetched without the token |

**In a sandbox** the token is given to the one git command the platform itself runs, and to nothing else
(`server/src/github/git.ts`):

- It is written to the command's standard input. It is in no argument and no environment variable, neither on
  the server (where Docker's would be on a `docker exec` command line) nor in the sandbox.
- The script reads it into a shell variable that is never exported and hands it to git on a pipe. Git is told,
  in its environment's configuration, of a credential helper that answers a request for GitHub's host by
  reading that pipe: the pipe is empty once git has read it, and git sends the token only where GitHub asked
  for it, as [GitHub documents it](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation):
  the HTTP password of the user `x-access-token`.
- That git runs with an empty environment, the system's own programs, without the system's and the user's git
  configuration and without hooks, so nothing writes the token down: a clone's `.git/config` holds the plain
  address, and there is no credential store, no temporary file, no remote with a token in it.
- A push never runs in the workspace's repository, whose configuration and hooks the agent can write: a
  remote rewritten to another host, a credential helper or a `pre-push` hook there would be handed the
  token. The commit is made in the workspace by a command that has no token. The push runs in an empty
  repository the script makes for it outside the workspace, which borrows the workspace's objects and nothing
  else, and is removed afterwards.

**What an agent's command can still observe.** That the platform cloned and pushed, the addresses and the
branch names. A command the agent runs afterwards finds the token nowhere. A process the agent left running,
as the same Unix user, while the platform's git command runs, sees that command's arguments and environment,
which hold no token; it could take the token off the pipe in the instant before git reads it (the push then
fails), or read git's memory where the kernel lets one process of a user trace another (Linux's
`ptrace_scope` 0; Ubuntu's default forbids it). A push from the panel is only made between turns, so such a
process is one the agent started earlier and left running in the background; a push the agent asked for is
made while its turn waits for the answer, and what the agent left running then is the same kind of process. An agent that could replace the sandbox's own
git or shell could take the next token; in the sandbox image it cannot (it is not root, and has no
capabilities). In each case what is taken is good for the contents of that one repository,
for the seconds until the platform revokes it, and never for pull requests, another repository or the user's
account. A sandbox layer that could run the platform's command as another user than the agent's, or outside the
sandbox altogether, would close these; `SandboxHandle.run` has no such option.

### The agent asks to publish

A user who tells the agent to "open a pull request", or whose long task ends while they are away, wants the
agent to be able to get its work out. The agent still has no GitHub credential and still pushes nothing: it
asks the platform, and the platform does what "Open pull request" does, with the same code
(`publishWork`, `server/src/github/publish.ts`) and the same tokens, each for one step and revoked after it.

- **What the agent can ask for.** That the session's work be committed and pushed to the session's own branch
  and that the session's pull request be opened, or, when it is open, pushed to and given the title and
  description of the request. It writes three things: the pull request's title and description, and the
  commit's message (the title, when it gives none). It names no branch: a request that names a branch other
  than the session's, or a base other than the branch the session started from, is refused, and so is
  whatever a push from the panel is refused for (no write access, a branch that moved at GitHub, a workflow
  file, nothing to push).
- **How it asks** (`server/src/agent-publish.ts`). Windlass offers its model the tools of MCP servers, and
  starts by itself the servers its user's own configuration file names. For a turn of a session on a
  repository of the GitHub connection, the sandbox layer writes one server into that file in the sandbox
  (`~/.config/windlass/config.json`), `windlass_platform`, with one tool, `publish`, and takes it out again
  when the turn has ended. The model reads of the tool in the list Windlass gives it ("Publish this session's
  work to GitHub: commit and push it to the session's own branch and open or update the session's pull
  request."), with the rest of its description when it looks the tool up. A session without such a
  repository, or on a deployment without a GitHub App, is given no such server and is told of no such tool.
  The user's own MCP servers go into the same file ("Account settings"); `server/src/windlass-config.ts`
  has what the platform writes there and how it is taken out.
  (Windlass's protocol has a place for a client's servers, `mcpServers` in `session/new`; this Windlass
  ignores it, which is why the server goes into the file.)
- **What the platform acts on.** The server is a mailbox: a few lines of Python that do nothing with a call but
  wait for an answer. The request is Windlass's own report of the call among the turn's events
  (`tool.called`, with the arguments), which the engine writes on its connection to the platform. The
  platform decides, publishes, and writes what the agent is to be told into a file the server waits for,
  which the server returns as the tool's result: what was published and the pull request's address, or why
  nothing was. The server names each call it gets in a progress notification, which Windlass passes on as
  an event of that call, so the platform knows which call waits for which file. No network path leads from
  the sandbox to the platform, and nothing the sandbox says is trusted: the server's name for a call is
  only a file name, the file is only what the agent reads, and a repository whose own
  `.windlass/config.json` names a server `windlass_platform` makes it the project's, which Windlass says,
  and then no call is acted on.
- **Windlass's own question.** Where it sandboxes commands, Windlass asks before every call of an MCP tool
  ("Allow the MCP tool windlass_platform/publish?"), and anywhere once content it does not trust is in the
  conversation. For this tool the sandbox layer answers that question itself, with "once": the call does
  nothing in the sandbox but wait. The timeline says so under the call ("The platform allowed this itself:
  the tool only hands the agent's request to the platform, which decides it."). The tool's results are the
  platform's own words, so its server is marked as trusted, and a result does not make Windlass ask about
  the commands that follow.
- **The user decides.** Unless the session lets the agent publish without asking, each request is put to the
  user where a tool call's question is put: "Allow the agent to open a pull request?" (or "... to push to
  pull request #12?"), with the repository, the branch and its base, the commit's message, and the pull
  request's title and description, and the answers "Allow once", "Allow for this session" and "Don't
  allow", with a note for the agent. Nobody answering within `WLP_QUESTION_TIMEOUT_MS` declines it, as with
  any question: the agent is told that nobody answered and that the work is not published, and the turn
  goes on to its end.
- **Allowing it beforehand is the session's setting.** "Let the agent publish without asking" is chosen in
  the launch form once a repository is picked, changed in the session's panel under "Pull request", and
  turned on by answering a request with "Allow for this session": one setting, kept with the session
  (`SessionSummary.publishUnasked`). It is not saved with the repository, beside the setup command and the
  secrets, because those are things the platform does for its user in every sandbox, while this is a
  permission given to an agent: saved for a repository it would hold for every later session on it,
  whatever that session was asked to do, and nobody would have decided it for that session. With it on,
  what is in the workspace goes to GitHub with nobody looking first, so it is given for one piece of work.
- **What the request holds is the model's text.** Each part has to be text and has a limit (the title 120
  characters, the description and the commit's message 4,000 each; past it the request is refused with the
  limit, so that the agent asks again), control characters are taken out, and so is every saved secret of
  the repository, before the user is shown it and before it goes to GitHub.
- **What the user sees afterwards.** One line in the timeline, as after a push from the panel, that begins
  with who allowed it: "The agent asked to publish, and you allowed it once. Opened pull request #12 in
  acme/harbor from windlass/fix-the-light-3f9a2c, with 3 files." and the pull request's address; or "...,
  and you did not allow it: ...", or why it did not go through. The panel's "Pull request" section shows
  the branch and the pull request as after a push of the user's own.

What a command the agent runs can do about any of this depends on where it runs:

| Profile | A command the agent runs | Publishing without asking |
|---|---|---|
| commands sandboxed by Windlass (`docker-windlass-sandbox`, E2B with its sandbox promised) | cannot read Windlass's configuration file, cannot write where the answers go (its home is not the sandbox's), sees no process but its own, and what it prints is a tool's output and nothing more: it can neither make a request nor answer one | can be turned on |
| commands not sandboxed (`docker-hardened`, `e2b-open`), or nothing promised (E2B before its check) | runs as Windlass's user: it can write a line on the engine's own connection to the platform (its standard output, through `/proc`), which reads as the engine's, and so can make a request in the agent's name, and it can write the answer the agent reads | cannot: every request is put to the user, whoever made it, the question says that a command could have asked it, and it offers no "Allow for this session" |

So where commands are not sandboxed a command can raise the question, and cannot publish by itself. That is
the same line as with a repository's secrets: where a promise does not hold by construction, the platform
does not rely on it. Both rows were tried on local Docker, with a command that did each of these things;
nothing of this has run on E2B yet.

**A sandbox that keeps an older Windlass.** The tool is offered only to an engine that lists `_windlass/mcp`
among its methods, which is what says whose a server is; an engine without it is told of no tool, and the
panel's button works as before. The configuration keys the server's definition uses are as old as
Windlass's MCP servers themselves.

### When a sandbox is replaced

A sandbox made in place of a lost one has a fresh workspace. Where the session's work was pushed, the clone puts
the workspace on the session's branch as GitHub has it now, not on the branch the session started from: what was
pushed is back, with anything pushed to that branch since, and what was only in the old sandbox is not. If GitHub
no longer has the branch (deleted after a merge, say), the workspace starts from the base branch again and the
timeline says so. The agent is told with its next prompt that the workspace is a fresh one.

### When it does not work

Each failure is said where the user is, in a sentence they can act on:

| What happened | What the user reads |
|---|---|
| GitHub says the user may read the repository and not write to it | "ada can read acme/quay on GitHub but not write to it, so the platform cannot push there for you. Ask an owner of acme for write access, then push again." Nothing is committed or pushed |
| a rule of the repository refuses the branch | "GitHub refused the push: a rule of acme/quay protects branches named like windlass/.... Let the GitHub App create such branches in the repository's branch rules, then push again." |
| the repository is gone, or no longer in the installation | "acme/quay is no longer on GitHub, or the GitHub App can no longer see it. ..." |
| the app was uninstalled from the account | "The GitHub App is no longer installed on acme. Connect GitHub again and install it there, then try once more." |
| the user disconnected GitHub | "GitHub is not connected any more. Connect GitHub again from the account menu, then try once more." A session launched on a repository stays, with its timeline and its pull request |
| the branch at GitHub has commits the workspace lacks | the push is refused rather than overwrite them, and the sentence says so |
| the push changes a file under `.github/workflows` | GitHub refuses it for an app without the workflows permission, which this one does not ask for; the sentence says so |
| GitHub cannot be reached | "GitHub could not be reached. Try again in a moment." |

A push that went through while its pull request did not (the permission is missing, say) is remembered: the
next "Open pull request" only opens it.

### Several servers

Nothing of this is on a server. A connection is in its user's actor, a state's number in the same actor, and
the ticket carries the rest, so the visits of one connection can be served by different servers, as can a
session's clone and its push. What a server keeps for itself, and asks for again when it is gone, is what it
last heard of an installation's repositories (a minute) and of a user's rights in them (five minutes, for the
launch form's list only: launching and pushing ask GitHub then and there).

### Checks

No check calls GitHub. `scripts/github-standin.ts` stands in for it: its API and token endpoints, its
authorization and installation pages, and a git remote over HTTP in front of real bare repositories, with
GitHub's refusals written from what is known of them and not copied from a run against it.

```sh
cd server && npx tsx ../scripts/github-check.ts             # the server's GitHub code and real git against the stand-in
cd server && npx tsx ../scripts/github-check.ts --docker    # and the git commands again in a container of the sandbox image
cd server && flock /tmp/wlp-test.lock pnpm e2e              # its last section: the route and the actors, on the fake layer
```

`github-check.ts` has the rules of a request of the agent's as well ("The agent asks to publish"): what it
may hold, the configuration file with the tool's server in it and out of it, and what `publishWork` does
with an open pull request for the agent and for the panel. The fake sandbox layer plays no such tool, so the
end-to-end test does not ask through the actors.

The web app's mock plays a deployment with a GitHub App (`?mock=1`; `&github=off` for one without), and
`__wlpMock.mockNextGithub("list" | "connect" | "denied" | "protected" | "gone")` in the console makes its next
call fail as GitHub can.

Not checked, because no check calls GitHub itself: the exact words of GitHub's refusals of a push (the
sentences above are chosen by them), what GitHub's installation page does with a `state` for an account that
has the app already, and that the callback after an installation carries a code as documented.

## A repository's setup command

Where Windlass sandboxes the agent's commands, a command has no network unless the user approves it, and
writes only in the workspace, in `/tmp` and in a home of the session's own. Installing a project's
dependencies inside a turn then means questions. So a user can save one shell command per repository of their GitHub
connection, `npm ci` say, and the platform runs it for them: once in each new sandbox of a session on that
repository, after the clone and before the agent's first turn there. The agent starts with the dependencies
in place, and its own commands stay sandboxed.

- **Whose it is.** The user's, and nothing else's. It is saved in their `user` actor, one row per repository
  (GitHub's id for it, so a rename keeps it), and a session reads it from there at the moment its sandbox is
  new. It is never read from the repository: it runs with the network and outside Windlass's sandbox, so a
  command taken from a repository's content would let a repository run code unasked. Nothing in a clone
  (`package.json` scripts, a `setup.sh`, `.windlass/`) is looked at for it. A session on a pasted address or
  with no repository has no setup.
- **Where the user sets it.** In the launch form, once a repository is chosen: the field shows what is saved
  for that repository, and what it holds is saved with the launch. And in a session's side panel, under
  "Setup command". A change is for the sandboxes made after it: one that has its clone is not set up again,
  and the panel says so. At most 2,000 characters; an empty one is none.
- **How it runs** (`server/src/sandbox/setup.ts`). `bash -c` with the command, as the sandbox's user
  `agent`, in the clone's directory, with the sandbox's own network, through the same seam as every other
  command the platform runs, so on Docker and on E2B alike. It is started under `wlp-run`, so a stop reaches
  every process it started. On E2B the sandbox is held for as long as it runs. Its standard error is joined
  to its standard output inside the sandbox, so its lines arrive in the order they were printed. It may take
  `WLP_SETUP_TIMEOUT_MS` (ten minutes), after which it is stopped.
- **Once per sandbox, not once per turn.** The clone marks the setup as due; the session marks it as done
  before the command starts, so a server that stops under it does not make the next turn run it twice. A
  sandbox made in place of a lost one is cloned into again and set up again.
- **What the user sees.** The run is in the session's timeline, where the clone's line is: the command, what
  it prints as it arrives, how it ended and how long it took. It is one item when it starts and one when it
  has ended (`kind: "setup"`), with `setup.output` deltas in between on the feed the model's streaming text
  uses; the ending item keeps the last 32,000 characters. The session's Stop stops it, and the turn with it.
- **If it does not succeed** (another exit code than 0, the time limit, a stop, a server that stopped under
  it), the session goes on: the turn is not failed for it. The agent is told once, before the next prompt
  Windlass takes, as it is told of a fresh workspace: the platform's note, the command, how it ended, and
  the last twenty lines of what it printed. The timeline keeps the prompt as the user wrote it.
- **No credential of the platform's is handed to it.** What it is handed is what the user saved for the
  repository as secrets ("A repository's secrets"). The token a clone used was given to that one `git clone` on its
  standard input and revoked when it ended, before the setup starts. A turn's ChatGPT access token file is
  written when a turn starts Windlass, which is after the setup, and removed when that turn ends; a new
  sandbox has had no turn. What the command can read is what the sandbox's user can: on E2B Windlass's data
  directory is the sandbox's own and holds no token then. On Docker that directory is the user's volume,
  shared by the user's sessions, so while another session of the same user runs a turn, its token file is
  there, as a command in the hardened profile can read it.
- **It is not a place for a secret.** The command is shown in the timeline and, when it fails, given to the
  agent with its output. A value the command needs is saved as a secret of the repository and read from its
  variable (`$NPM_TOKEN`); what the command prints of it is shown without it.
- **What it leaves in the workspace is the workspace's.** Files it makes that the repository does not ignore
  are listed under "Changes" and go into a push like any others.

```sh
cd server && npx tsx ../scripts/setup-check.ts    # its rules on their own: what it is saved for, the limits, what is kept, what the agent is told
```

The web app's mock has a setup command saved for acme/harbor (`?mock=1`); a command with the word "fail" in
it ends with exit code 1 there.

## A repository's checks

A check is a command that tells whether the code is right: `npm test`, `cargo clippy`. Windlass has a
verification gate for them: before it calls a turn done it runs the checks that apply to what the turn
changed, in the agent's own sandbox, and when one fails it shows the agent what failed and sends it back,
three times at most (`checks` and `verify` in its configuration, its docs/user-guide.md, "Verification
checks"). With no check set the gate runs nothing and every turn ends "no checks configured". So a user
saves checks for a repository of their GitHub connection, and the platform hands them to Windlass for every
session on it.

- **Whose they are.** The user's, kept in their `user` actor, one row per repository (GitHub's id, as for
  the setup command) with the whole list (`server/src/repository-checks.ts`). They are never read from the
  repository: a file there is something an agent can edit during a turn. A session on a pasted address or
  with no repository has none of the user's.
- **What one is.** A name and a command, and what Windlass's own configuration takes besides, within its
  limits: how long it may run (1 to 3,600 seconds; Windlass's default is 120) and glob patterns of changed
  files that make it run (none: any change does). And one setting of the platform's: that the end of the
  check's output goes into a pull request's description also when it passed. A repository can have 20
  checks. What is saved is what Windlass reads: a name it would refuse, two checks of one name, or a
  pattern that starts with `!` is refused when it is saved, because Windlass fails a turn whose checks it
  cannot read.
- **Where the user sets them.** On the repository's Settings, under the setup command
  (`/repositories/<id>/settings#checks`). The list is saved
  whole, by one statement that reads nothing first, so of two saves that run together one stays as it was
  sent, and neither undoes a setup command or a secret saved meanwhile.
- **Two kinds of Windlass.** What a repository's own `.windlass/config.json` can do to the user's checks
  depends on the Windlass in the session's sandbox. One with *required checks* (its docs/safety.md,
  "Required checks"; 0.3.0, which the image has) runs them whatever that file says. The released 0.2.0
  has none: there a repository's list stands in for the user's. A sandbox keeps the Windlass it was made with, so
  the platform asks each sandbox's Windlass, with the question it asks already ("Sandboxes that keep an
  older Windlass": `requiredChecks` among the keys it lists), and each turn goes by the Windlass it runs
  on. The session's summary carries the answer (`SessionSummary.requiredChecks`), and the repository's
  Settings say under the checks which of the two holds in the sandboxes of the user's agents on it, as far
  as they have said. A session made under 0.2.0 carries on in a sandbox with 0.3.0. The
  other way about it does not: once 0.3.0 has recorded anything about checks in a session
  (a run of them, or the ending of a turn with checks in force), 0.2.0 refuses to open it, whole: the
  record has fields 0.2.0 does not know (Windlass's changelog, 0.3.0, says the same). So an image is
  not to be rolled back to 0.2.0 while such sessions are in use. A turn that meets this ends with what the user can do about it instead of
  Windlass's "Internal error": the session is unchanged and opens again in a sandbox with the Windlass
  that last worked in it, so the image is to be built from that one, the agent's sandbox freed (what
  was not pushed goes with it) and the prompt sent again; or a new agent started. The platform says so
  on a structured fact and never on a message's words. A Windlass that refuses a session with a
  reason (0.3.0, of one a later Windlass wrote to: `unreadable_session`, with a sentence that names
  the record) is taken at its word. 0.2.0
  gives none, only JSON-RPC's internal error, which the sandbox layer hands on as that
  (`open_refused`); the session's actor then goes by what it knows: this sandbox's Windlass takes no
  required checks, and one that does ended a turn of this very Windlass session with checks in
  force (`checksRecorded`), which is exactly what 0.2.0 does not read. Any other internal error at
  the open stays "Internal error".
- **With required checks: named when the session is opened.** A session reads the checks from the user's
  actor when a turn starts, with its repository's secrets, and the sandbox layer names them to Windlass in
  the metadata it opens the session with (`_meta.windlass.requiredChecks` on `session/new` and
  `session/resume`, `server/src/sandbox/turn.ts`), with `outputTail: "always"` on a check whose output
  is to be shown also when it passes. Windlass keeps them with the session for as long as its process
  has it open and stores them nowhere, so they are said at every open, which for the platform is every
  turn: a change is for each session's next turn. Windlass offers a second place for such checks,
  `requiredChecks` in its user's own configuration file. The platform does not use it, because that file
  is in the sandbox: where commands are not sandboxed (`docker-hardened`, `e2b-open`) a command of the
  agent's can write it, and a check that a turn can remove before the next verifies nothing. What is
  named at the open is held by Windlass's process and comes from the platform's process each time; no
  file in the sandbox has it. It also needs no file a Windlass without the key would refuse to read,
  and its record tells the two apart: a check the platform named has the origin `session`, one from
  that file `user`.
  - They run before the repository's own checks, which run too, and gate the turn: a failing one sends
    the agent back, three times at most, whatever the repository's file says about `checks` (an empty
    list too) or `verify` (`mode` `off` or `report`, `maxRounds`). A check of the repository's with the
    name of one of the user's is not run: under that name the user's runs.
  - A turn keeps the checks it started with. A repository's file the agent writes or changes during a
    turn changes nothing for the user's checks, in that turn or the next; the pull request says that
    the file changed ("What is looked for in the changes").
  - They run in the session's working directory, which is the workspace, the repository's root, and
    their file patterns are relative to it. A `.windlass/config.json` further down in the repository
    does not move them.
  - Where commands are sandboxed and no sandbox can run, a required check cannot be run either.
    Windlass records it as one that could not be started, with the reason, and ends the turn at
    once as unresolved (`not_started`). The agent is not sent back: nothing it changes in the code
    starts a check. The platform then says that nothing was verified and that the agent was not
    asked to change anything, and shows the reason with the check as the thing to fix. The same
    holds for any check whose command could not be started at all; beside checks that failed on
    the code, the agent is sent back for those alone, and the platform counts and words the two
    apart.
  - A check the user adds, or whose command, time limit or patterns the user changes, does not
    stand on what was verified without it: Windlass runs it at the end of the session's next turn
    that changes a file, whatever the file, and from then on for what its patterns cover.
  - A subagent's turn runs no check; the session's own turn, which the platform sees end, runs them
    over everything the subagent changed in the workspace.
  - `checks`, `requiredChecks` and `verify` in Windlass's own configuration file in the sandbox are
    still the platform's alone, and it still takes out what a command left under them before every
    open: the number of times the agent is sent back is that file's to say.
- **Without them: written into Windlass's own file.** The sandbox layer writes the checks into Windlass's
  own configuration file in the sandbox (`~/.config/windlass/config.json`) as its `checks`, in the step
  that writes the user's MCP servers there and by the same code (`server/src/windlass-config.ts`); they
  are taken out again when the turn has ended. Windlass reads the repository's `.windlass/config.json`
  too, and follows it before its user's file, key by key: a `checks` list there stands in for the user's
  whole, an empty one too, and `verify.mode` there can turn the gate off or make it report without sending
  the agent back. Windlass reads both files when a turn starts and not again in it.

  | The repository's `.windlass/config.json` | Windlass 0.2.0 | A Windlass with required checks (0.3.0) |
  |---|---|---|
  | is not there, or says nothing of checks | runs the user's checks | runs the user's checks |
  | names `checks` | runs those, and none of the user's: a turn can end as done without one of the user's checks having run | runs the user's, then those |
  | names `checks: []` | runs nothing, and reports that no checks are configured | runs the user's |
  | sets `verify.mode` to `off` | runs nothing, and reports that no checks are configured | runs the user's, and none of the repository's own |
  | is written or changed by the agent during a turn | changes nothing in that turn; from the next turn on it is followed as above | changes nothing for the user's checks, in that turn or later |
  | cannot run checks: commands are sandboxed and there is no sandbox | runs nothing, says so, and calls the turn done | records the user's checks as not started, and ends the turn as unresolved, at once |

  Both columns were tried against the real thing, the released 0.2.0 and the released 0.3.0
  (`scripts/verified-check.ts --docker`). 0.2.0's record of a run does not say which file
  a check came from. The platform does not rewrite a repository's file. It says whose checks ran, and for
  that the sandbox layer reads the repository's file when it writes its own, in the same step, and hands
  on what it holds about checks (`projectChecks`). On 0.2.0 a check is presented as the user's only when
  both hold: the repository's file named no list when the turn started, and the check's name and command
  are those of a check the platform handed over. Anything else is presented as the repository's.
- **Where commands are not sandboxed.** In `docker-hardened` Windlass runs checks as it runs the agent's
  commands there, without its sandbox. A command of the agent's can write Windlass's own configuration
  file there; the next turn takes out what it left about checks before Windlass reads it, and with
  required checks the user's are not in that file at all. A command there can still reach Windlass's
  process itself, as it can the engine's connection to the platform ("What it cannot say" below).

```sh
cd server && npx tsx ../scripts/verified-check.ts                                   # the rules on their own: what may be saved, the configuration file, a turn's events, the section
cd server && flock /tmp/wlp-test.lock npx tsx ../scripts/verified-check.ts --docker # and what a real Windlass does with a user's checks and a repository's own: the image's, and the last release without required checks (`sandbox/fetch-windlass.sh older`)
```

The web app's mock has two checks saved for acme/harbor (`?mock=1`, `/repositories/7101/settings`), one of them with
file patterns that the mock's turns never match. Its sandboxes have a Windlass with required checks, except
the one of "Make add() pass its checks", which keeps an older one; the fake sandbox layer's Windlass has them
too, and its evidence of a run names what the run's changes are measured from and the session's required
checks, as the real one's does. A mock turn on a repository whose checks all have patterns ends with no
check needed because none covers what changed, said as that.

## What a pull request shows was verified

A pull request an agent opens says what the agent claims. So the platform adds, to the description of every
pull request it opens, a section that says what was checked, from what Windlass recorded and not from what
the agent wrote, and writes it again with every later push (`server/src/verified.ts`,
`server/src/github/publish.ts`):

```markdown
<!-- windlass-platform:verified -->

### What was verified

The 2 checks that applied passed when the agent's turn 1 ended.

- **test** (`node test/add.test.js`), ada's required check: passed in 73 ms after the agent was sent back once.
- **smoke** (`node scripts/smoke.js`), from the repository's `.windlass/config.json`: passed in 41 ms.

Did not run: **docs** (`test -f docs/index.md`). No changed file matches its patterns.

The repository's `.windlass/config.json` says something about checks too. That holds for the repository's own checks: ada's checks are required, and that file can neither replace them nor switch them off.

To look at:

- Test files were deleted or renamed away: `test/sub.test.js`.

<sub>Written by Windlass Platform from what Windlass recorded of the session's checks, and replaced each time the platform pushes. It says what ran; it is not a review.</sub>

<!-- /windlass-platform:verified -->
```

- **What it says.** How the gate ended in the session's last turn, in one sentence. Each check of the
  session's last run of checks: its name, its command, whose it is (the user's, by their GitHub login, or
  "from the repository's `.windlass/config.json`"), how it ended, how long it took, and how many times in
  that turn the agent was sent back with it failing. A check of the user's that Windlass ran as a
  required check is "ada's required check"; on a Windlass without required checks it is "ada's check",
  as the example above would then have it, without the repository's own beside it. The user's checks
  that did not run, with the reason: no changed file matched their patterns, or, on a Windlass without
  required checks, the repository's file named a list of its own ("The repository's
  `.windlass/config.json` names checks of its own, and Windlass follows a repository's list in place of
  ada's checks."). Where the user's checks were required ones and the repository's file said something
  about checks or verification, one sentence says whom that held for. The end of a check's output,
  folded, for one that did not pass and for one whose user asked (1,500 characters, of six checks at
  most). And when nothing was verified, one plain sentence: "Nothing was verified: no checks are
  set for this repository.", or which file turned verification off, or that the turn was stopped before
  its checks had run. There is no badge and no tick in it, and it ends by saying that it is not a review.
- **What a turn that needed no check rests on, and a check that was not started.** Windlass 0.3.0
  says more than 0.2.0 in two places, and the platform says it after it
  (`Verified.unneeded`, `putBack`, `VerifiedCheck.startError`). A Windlass that does not say it is
  told as before, word for word: nothing is worked out in its place.
  - *Why no check was needed* (`reason` of the ending). "The turn changed no file." is told apart
    from "no check covers the files that differ from the state the checks last passed on, at the end
    of turn 1", and from a turn that changed files and put them back.
  - *A check failed, and the agent put the files back.* Windlass then runs nothing more, and its
    ending names the verified state the files are in again and the run that last passed on the way
    to it (`since`). The section says so: "No check was run again when the agent's turn 2 ended: the
    files the checks cover are again as they were when the checks last passed, at the end of turn
    1.", one sentence about the run that did not pass ("A run of checks earlier in turn 2 did not
    pass (**test** failed with exit code 1 after 80 ms, and the agent was sent back once). The agent
    then changed the files back, so that run says nothing about the work as it is now."), and that
    earlier run's checks under "The checks as they passed when turn 1 ended:". The failed run is not
    listed as a result, its output is not shown, and nothing is flagged as changed after the checks
    unless a file no check covers differs from what that run passed on. Where no run has passed,
    the state is the one the session started from: "a state no check has verified", and no run is
    listed. The run is found by where it is in Windlass's log (`seq`), which the record keeps for
    the session's last run. A run the platform does not hold (an earlier turn left a check failing
    since) is not made up: the sentence then names no turn and no run is listed.
  - *A check that was not started* (`could_not_start` with no exit code, and `startError`) did not
    fail. When every check that did not pass is one of those, Windlass ends the turn at once
    (`not_started`): "Nothing was verified in the agent's turn 1: the check that applied was not
    started. That says nothing about the code, so the agent was not sent back to change anything:
    what there is to fix is the reason given with the check below.", and the check's line is "was
    not started:" with Windlass's reason. Beside checks that failed on the code the sentence counts
    those alone and adds that another was not started; the agent was sent back for the failing ones
    only, and the line of the other says no number of times. A check whose command the shell did
    not find (exit code 126 or 127) ran, and is told as before.
- **Where the facts come from.** Windlass's own events of the turn, each decision on a field of them and
  none on a sentence: `checks.finished` has the evidence of a run (each check's name, command, status,
  exit code, duration and the file its output is kept in); a message the harness appends with the origin
  `check_report`, followed by a model call (`step.started`), is the agent being sent back (Windlass
  writes the same message with an ending that leaves checks unresolved, for whoever continues the
  session, and that one sends nobody back); `execution.succeeded` has how the gate ended, why a turn
  was let end with a check failing, and from 0.3.0 on why no check was needed and on what;
  `snapshot.taken` names each state of the workspace. A key of the evidence or of an ending that the
  platform does not know is passed over, and an ending is never compared whole. The session's
  actor keeps what they come to (`Verified`) on the item that ends the turn, and in its own state for the
  next push. A turn in which no check ran keeps what the last run found, with the turn it was in.
- **One record, two sources.** Three of those facts have another source on a Windlass with required
  checks, and which source a turn's record is made from is decided in one place, on one field
  (`VerificationLog.verified`, on `TurnChecks.required`: what the turn's own Windlass said it takes).

  | The fact | With required checks | Without |
  |---|---|---|
  | Whose a check is | the evidence's `origin`: `session` is a check the platform named for the user, anything else is not the user's | worked out from the two files, as Windlass merges them ("A repository's checks") |
  | Whether it is required | the evidence's `required` | never |
  | The end of its output | the evidence's `outputTail`, which Windlass keeps for a check that did not pass and for one whose entry asks, redacted | read from the file in the sandbox that the evidence names, when the turn has ended |

  Everything after that is the same code: the record, the section, the session's screen.
- **What is looked for in the changes.** Once the work is committed, the platform reads it against the
  branch it started from, in the sandbox (`git diff` from the merge base, with no program of the
  repository's choosing), and lists what a reviewer would want to look at, as observations
  (`workFlags`). The list is short on purpose:

  | It says | When |
  |---|---|
  | Test files were deleted or renamed away | a file that is a test's was deleted, or renamed to a path that is not a test's. A test's file is one named like a test (`*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*_spec.rb`, `*Test.java`, ...), or code in a directory `test`, `tests`, `__tests__`, `spec` or `e2e` that is not under `fixtures`, `helpers`, `mocks`, `data` and the like. A test renamed to another test's path is not listed |
  | Tests were newly skipped or disabled | a test's file gained more of these than it lost: `it.skip`, `test.skip`, `describe.skip`, `.todo`, `xit(`, `xdescribe(`, `@pytest.mark.skip`, `skipif`, `xfail`, `@unittest.skip`, `pytest.skip(`, `@Disabled`, `@Ignore`, `#[ignore]`, `t.Skip(`. A marker that was there before and still is, and a marker in other code, are not listed. A test that was commented out or deleted from its file is not seen |
  | What the checks run was changed in this work | the repository's `.windlass/config.json` says something else about `checks` or `verify` than on the base branch; or a script that a check's command runs was changed (a file run by itself, handed to a shell, or handed to an interpreter as the program; not a file the command only names, and not a test's file, which the two flags above are for); or the `package.json` script that a check's command runs through `npm`, `pnpm`, `yarn` or `bun run` was changed. The checks are the user's and the ones that ran |
  | A check's command came to ignore an exit status | one of those three (a command in the repository's own list, the script, the file a command names) has more of `\|\| true`, `\|\| :`, `\|\| exit 0`, a closing `; true` or `; exit 0`, or `set +e` than before. A user's own command that always had one is not this work's, and is not listed |
  | Files changed after the checks last ran | Windlass recorded another state of the workspace after the last run of checks than the one they ran on: a turn stopped between a failing run and the next, or a later turn that changed files and ran no check. Where Windlass took no snapshots, that a call which can change files started after the run. Not where Windlass says that the files are again as they were when the listed run passed |

  When git could not be asked, the section says that nothing was looked for.
- **Replaceable by the platform alone.** The section stands between two comment lines, at the end of the
  description. With every push the platform takes the description as it is at GitHub, removes whatever
  stands between such lines and any stray one, and puts the new section at the end: text a user wrote or
  edited at GitHub stays, and a section an agent wrote into its own description, lines and all, does not.
  Text that goes into the section cannot close it early: the lines' name is taken out of commands and
  output, and output is fenced by more backticks than it holds.
- **Nothing a redactor would hide.** The section leaves through both existing redactions: the saved
  secrets of the session's repository and account are taken out by value, and whatever is shaped like a
  credential by the GitHub layer's own (`server/src/github/redact.ts`). A check's output was redacted by
  Windlass before it was kept, in its record as in its file (`[REDACTED:openai-key]` and the like stand
  where a credential was), and the saved secrets are taken out of either on the way: out of every event
  of the engine's as it arrives, and out of a file when the platform reads it.
- **A push the agent asked for is made before its turn's checks run.** The gate runs when a turn ends,
  and the agent asks the platform to publish during it. The section then says so first ("This was pushed
  while the agent's turn 3 was still running: what that turn changed had not been checked yet."), with
  what earlier turns found after it. When that turn has ended and the workspace holds nothing GitHub
  lacks, the platform writes the section again, without a push, and the timeline says so. When the turn
  changed files after the push, the description stays as it is until the next push.
- **In the session.** The turn's closing line in the timeline has the same facts for that turn: the
  checks with how each ended, whose it is ("yours", "yours, required", "the repository's file") and how
  often the agent was sent back (or why it was not started), the user's checks that did not run and why, whom the repository's own
  settings held for, and that files changed after the checks last ran. The line of a push says what the
  description reports, in a few words, and the repository's Work view lists them beside each open pull request
  (`PullRequestInfo.verified`): "2 checks passed", "1 of 2 checks failing", "nothing verified",
  "1 check passed (the repository's own)", "no check was needed", "no check covers what changed",
  "nothing verified, 1 check not started", "1 of 2 checks failing, 1 not started", with "1 thing to
  look at" where the section lists some. The turn's closing line also says which state the files are
  back on, lists what did not pass before the agent changed them back apart from the checks the work
  rests on, and gives the reason a check was not started with it. Windlass's own run of checks in
  the timeline says "not started" of such a check, not "failed".
- **What it cannot say.** That the checks are good ones. That a check which passed tested what changed.
  On a Windlass without required checks, what the repository's file did in a turn the platform could
  not read it in. And where commands are not
  sandboxed, a command can write on the engine's connection to the platform ("The agent asks to
  publish"), so an agent that set out to could forge the events themselves; in the profiles where
  Windlass sandboxes every command it cannot.

**What a required check does not promise** (Windlass's docs/safety.md has the whole of it). Its command is
the user's; what the command runs is the repository's: `npm test` runs the script `package.json` names and
the tests the agent can edit, which is what the flags above look at. It runs only for a turn that changed a
file its patterns cover. The agent may say that it cannot make one pass, or be sent back as often as a
turn allows: the turn then ends as unresolved, never as done, and the section says so. And in the profiles
where commands are not sandboxed, the paragraph above about forged events holds for required checks too.

## A repository's secrets

A project needs values that must not be in its repository: a registry's token for `npm ci`, the key of an
API an MCP server calls, a database address. A user saves them for a repository of their GitHub connection,
each under the name of an environment variable, and the platform hands them to that repository's sessions as
environment variables. A value is never written into the repository or the workspace by the platform, and
never shown again once it is saved.

- **Whose they are, and where.** The user's, in their `user` actor, one row per repository (GitHub's id, as for
  the setup command) and name: the name, a scope, when it last changed, and the value, encrypted
  (`server/src/signin/seal.ts`, AES-256-GCM under a key derived from `WLP_SIGNIN_KEY` or `WLP_SECRET` for this
  purpose alone, and bound to the user, the repository and the name: a value put into another row does not
  open). "Sign-ins" says what that encryption protects against and what not; the same holds here. A session
  on a pasted address or with no repository has no secrets.
- **Write-only.** The value goes from the browser to the user's actor once, when it is saved. No action sends
  one back: the list has names, scopes, dates and what each secret reaches, and the query behind it does not
  read the value's column. A value can be replaced or deleted.
- **What may be saved.** A name is an environment variable's (letters, digits, underscores, not starting with
  a digit, at most 64 characters) and none the sandbox, Windlass or the platform's own commands rely on:
  `WLP_*`, `WINDLASS_*`, `PATH`, `HOME`, `LD_*`, `XDG_*` (where Windlass keeps its data), `BUN_*` and `NODE_*`
  (the Windlass executable is a Bun program), `BASH_*`, `ENV`, `IFS`, `DOCKER_*`, `E2B_*`, the locale and
  proxy variables, and a few more (`isReservedName`, `server/src/repo-secrets.ts`). A value has 8 characters
  or more, since a shorter one could not be taken out of what is shown without taking ordinary words with
  it, and at most 16,384 bytes; it may have several lines. A repository can have 50 secrets, a user 2,000.
- **Two scopes.** Every secret goes to the repository's setup command. Beyond that, "Setup and MCP servers"
  (the default) is for the MCP servers the repository names, which read it as `${NAME}`, and not for the
  commands the agent runs; "Also the agent's commands" is for those commands too. The second is a choice the
  interface explains: whatever the agent's commands can read, a manipulated agent could send out once a
  command has network access, and whatever a command prints goes to the model. The first keeps a value from
  the agent's commands, not from the model: what an MCP server's tool returns goes to the model, and a
  server that returns the value has shown it.
- **What a scope comes to is decided by Windlass, and the platform tells it by name.** Windlass hands its own
  environment on by a rule (`packages/core/src/sandbox/policy.ts`, `command.ts`, `mcp/config.ts` in its
  source): an MCP server gets the variables its definition names; a command Windlass sandboxes gets every
  variable except those whose names look like credentials (a name that contains `TOKEN`, `KEY`, `SECRET`,
  `PASSWORD`, ..., or begins with `AWS_`, `OPENAI_`, ..., or is `DATABASE_URL`, ...); a command it does not
  sandbox gets all of them. Whoever opens a session corrects the rule with two lists of names (its
  docs/safety.md, "A command's environment"): a variable in `withholdEnv` is given to no command the agent
  runs and still to an MCP server, and a credential-looking one in `passEnv` is given to sandboxed commands
  all the same. The platform hands Windlass a secret in its environment and says both lists with every
  `session/new` and `session/resume` (they hold names, never a value, and are not stored with a session):
  every secret that is for the setup command and MCP servers is named in `withholdEnv`, whatever its name,
  and a secret for the agent's commands whose name looks like a credential is named in `passEnv`
  (`windlassEnvironment`, `server/src/repo-secrets.ts`). Where Windlass sandboxes every command that makes
  a scope exact: a command is not given a withheld variable, and it cannot read it from Windlass's process
  either, since it sees no process but its own.
- **Where commands are not sandboxed, withholding is not relied on.** A command that runs without
  Windlass's sandbox is not given a withheld variable either, but it runs as Windlass's user and can read
  Windlass's environment from `/proc`. So where commands run that way, or may, a secret that is not for the
  agent's commands stays out of Windlass's environment altogether, and MCP servers go without it:

  | The secret | Commands sandboxed by Windlass (`docker-windlass-sandbox`, E2B with its sandbox promised) | Commands not sandboxed (`docker-hardened`, `e2b-open`), or nothing promised (E2B before its check) |
  |---|---|---|
  | setup and MCP servers, any name (`NPM_TOKEN`, `SENTRY_DSN`) | setup command, MCP servers | setup command only |
  | also the agent's commands, any name (`PREVIEW_HOST`, `DEPLOY_KEY`) | setup command, MCP servers, commands | setup command, MCP servers, commands, also the ones Windlass sandboxes again once content from the web or an MCP server is in the conversation |

  Where a secret reaches less than its scope says, the list says so under it, for the sandbox of the
  session (or the one chosen in the launch form), with the reason (`secretReach`). One promise is not made:
  where commands are not held in Windlass's sandbox, an MCP server is given nothing they are not meant to
  have.
- **A sandbox that keeps an older Windlass** ("Sandboxes that keep an older Windlass") has the rule and no
  lists, so there a variable in Windlass's environment is kept from a command by its name alone, and the
  platform hands Windlass only what keeps the scope true by that:

  | The secret | Commands sandboxed by Windlass | Commands not sandboxed, or nothing promised |
  |---|---|---|
  | setup and MCP servers, a name Windlass withholds (`NPM_TOKEN`, `DATABASE_URL`) | setup command, MCP servers | setup command only |
  | setup and MCP servers, any other name (`SENTRY_DSN`) | setup command only | setup command only |
  | also the agent's commands, a name Windlass passes on (`PREVIEW_HOST`) | setup command, MCP servers, commands | setup command, MCP servers, commands |
  | also the agent's commands, a name Windlass withholds (`DEPLOY_KEY`) | setup command, MCP servers; **not** commands | setup command, MCP servers, and the commands Windlass runs without its sandbox |

  The list is said for the sandbox it is asked about. A session records what its sandbox's Windlass
  answered when a turn last asked it (`SessionSummary.envLists`), and its panel's list goes by that: a
  session whose sandbox has the older Windlass reads the sentences of this second table, and a sandbox
  that replaces it gets the first. A sandbox no turn has asked was made before the platform asked, and is
  taken to have the older one until its next turn. The launch form's list, and that of a session with no
  sandbox yet, is said for a sandbox made now, from an image with a Windlass that has the lists ("Run it");
  where the image's own is older, a session's list says so from its first turn.
- **The copy of Windlass's credential names.** Which names Windlass keeps from sandboxed commands has to be
  known before Windlass is started: it decides what goes into `passEnv`, and with an older Windlass what
  a secret reaches at all. Windlass cannot be asked, so its lists are repeated in `looksLikeCredential`.
  They must change when Windlass's do: with a name the platform takes to be passed on and Windlass
  withholds, a secret for the agent's commands would not reach them; and in a sandbox with an older
  Windlass, with a name the platform takes to be withheld and that Windlass passes on, a secret for setup
  and MCP servers would reach the agent's commands. `scripts/secrets-check.ts` holds the copy against
  Windlass's source when that is beside this repository.
- **When a change takes effect.** A session reads its repository's secrets from the user's actor when a turn
  starts. Windlass is started for each turn, so MCP servers and the agent's commands have a new, replaced or
  deleted secret from the session's next turn; a turn that is running keeps what it started with. The setup
  command runs once in each new sandbox, so it gets a change in the sandboxes made after it. Deleting a
  secret takes nothing back that a setup command already made of it in a workspace.
- **In the sandbox.** A value reaches a process in its environment and is on no command line: not the
  server's (on Docker a variable would otherwise be an argument of `docker exec -e NAME=value`, readable by
  anyone on the machine who lists processes; a secret is only named there, `-e NAME`, and the `docker` client
  takes the value from its own environment), and not in the sandbox. On E2B it goes in the request that
  starts the command. The session's actor holds the values in memory for one turn, on the turn's own
  record, and never in its stored state. Whoever can read a process's environment in the sandbox can read
  what that process was handed: where commands run directly in the sandbox machine that is every command of
  the agent, for Windlass and the MCP servers it started; where Windlass sandboxes commands, they see no
  other process.
- **What is shown.** Every saved value of the session's repository is taken out of what leaves the sandbox
  layer, and replaced by `[secret:NAME]`: the setup command's output as it streams and in its timeline item,
  every event of a turn (tool output, the model's text, a question, the description of a project's server),
  the end of standard error and the sentence of a failure, the note the agent is given about a setup that
  failed, and the server's log lines that quote any of these. A value split over two pieces of streaming
  output is held back until it is whole. The session's actor does it once more for every item a turn adds to
  the timeline, whoever wrote it, and for the workspace's diff, since a setup command may write a value to a
  file. Windlass has a redaction of its own for the values of its credential-named variables
  (`[REDACTED:env]`), which comes first where it applies. Not found: a value a program changed before
  printing it (base64, a part of it), and a value of a secret that was deleted or replaced since.
- **What the platform does not keep a value from.** A process that was handed it. A setup command can write
  a secret into a file of the workspace (a `.npmrc`), where the agent's commands read it and a push publishes
  it; an MCP server can send it anywhere. And a secret for the agent's commands that a command prints is in
  Windlass's own record of the conversation, in the sandbox and in its copy in the bucket, and goes to the
  model, unless its name is one Windlass redacts.
- **Who may read them.** The value's only reader is a session of the same user, for its own repository:
  `internalSessionSecrets` takes a service token made for exactly that user and session, and looks the
  session's repository up in the user actor's own index instead of taking it from the call. The answer is
  the sealed values; the server that runs the turn opens them. Another user who can open the same repository
  has secrets of their own for it, and sees and is handed none of these.
- **Where the user manages them.** In a session's side panel, under "Secrets", beside the setup command, and
  in the launch form once a repository is chosen ("Manage…"): add, replace a value, change a scope, delete.
  The value's field is a password field and is empty whenever it is shown; a value of several lines goes into
  a field that hides it the same way.

```sh
cd server && npx tsx ../scripts/secrets-check.ts    # the rules on their own: names, limits, scopes, sealing, the list, redaction
```

The web app's mock has four secrets saved for acme/harbor (`?mock=1`), each scope under a name that looks
like a credential and under one that does not; it keeps no value at all. One of its seeded sessions on that
repository (`/agents/checks`) has a sandbox with the older Windlass, and its panel shows the sentences of the
second table.

## A project's MCP servers

A repository can name MCP servers in `.windlass/config.json`, and a session that works in a clone of it gets
them with the rest of the project. Windlass does not start such a server by itself: opening a repository must
not run a command the repository chose. It asks, and the platform puts that question to the session's user in
the same place as a tool call's question, with the same control.

- **When.** Before a turn's prompt goes to Windlass, the sandbox layer asks it which servers wait
  (`_windlass/mcp`), as Windlass's own command line does before it sends a message. Each is a question: the
  server's name, its command with every argument (or its address), the file that defines it, and two answers,
  "Start it for this project" and "Not now". The session is `waiting` meanwhile, and the turn starts with what
  was allowed: a server approved then runs, and is in the model's list of tools, at the turn's first model
  call. A server Windlass reports while a turn already runs (`_windlass/mcp_changed`) is asked about without
  holding the turn: approved, it starts at once and the model is told of its tools at its next step, and the
  question goes with the turn if nobody answers it.
- **A tool call's question comes first.** While one waits, a server's question steps aside, and it is put
  again afterwards with its whole time to be answered in.
- **What the question says.** Windlass's own explanation is that the server "runs outside the sandbox, with
  your permissions". Here that means: it is a process in the session's sandbox machine that Windlass's sandbox
  around commands never holds, so it has the network and can read Windlass's data directory, where the turn's
  access token file is. The question says so for the profile the session runs in
  (`server/src/server-question.ts`):

  | Profile | The question's first sentence |
  |---|---|
  | commands sandboxed by Windlass | "It runs in this session's container, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the network and can read Windlass's own data, including the session's access token, which lasts about an hour and cannot be renewed." |
  | Docker, hardened | "It runs in this session's container, as the agent's commands do here: like them, it has the network and can read Windlass's own data, including ..." |
  | E2B before its check has passed | "It runs in this session's microVM and is never inside Windlass's sandbox around commands, whether or not that sandbox works here: it has the network and can read Windlass's own data, including ..." |

  A demo session is handed no access token, and its question says that instead.
- **What follows.** One line in the timeline: "Started the MCP server "harbor" for this project: 2 tools. The
  agent has them from this turn on.", or "Left the MCP server "harbor" stopped. If the agent tries to use it,
  it is told that the server waits for you; your next message asks again." A question nobody answers within
  `WLP_QUESTION_TIMEOUT_MS` is settled as "not now", says so, and the turn goes on.
- **Variables.** Windlass fills `${NAME}` in a definition's `env` and `headers` from its own environment and
  does not start a server that names a variable which is not set. A repository's secrets are what sets one
  ("A repository's secrets"). The question says which saved secrets approving hands over ("Its definition
  reads the secret HARBOR_TOKEN saved for this repository: approving gives its value to the server.", or
  "... sends its value to that address."). For a variable that is not set it says what would set it ("It
  will not start yet: its definition reads the variable HARBOR_TOKEN, which is not set where Windlass runs.
  Save a secret named HARBOR_TOKEN for acme/harbor, under Secrets in this session's panel: it is handed over
  from the next turn."), or, where a secret of that name is saved and the session's sandbox keeps it from MCP
  servers (commands are not held in Windlass's sandbox there, or its Windlass is an older one), why. An
  approval of such a server ends in Windlass's own reason and the same sentence. A session on no
  repository has none to save a secret for: there the sentence adds that a secret of the user's account
  under that name sets the variable, where the session's sandbox gives those to MCP servers ("Account
  settings").
- **What is remembered, and where.** Windlass keeps an approval in its data directory, for the project
  directory and exactly that definition, for 30 days. On E2B that directory is on the sandbox's disk, so by
  itself an approval would hold for one sandbox: every new session on the repository would ask again, and so
  would a session whose sandbox was replaced, in the middle of a conversation the server was approved in. So
  the platform keeps a record of its own (`server/src/server-approvals.ts`), in the user's `user` actor, which
  every session of that user reaches from whichever server it runs on:

  | What | Value |
  |---|---|
  | whose | the user's: one table in their `user` actor, plain rows, no credential |
  | the project | the GitHub repository, by GitHub's id for it (a rename keeps it), when the session was launched on one through the GitHub connection; the pasted address, exactly as it is stored, when it was launched on one; the session itself when it has no repository |
  | the server | its name, and Windlass's fingerprint of its definition: a changed definition is asked about again |
  | until | 30 days after the user approved, the time Windlass keeps its own. Using the record does not renew it; approving again does |
  | when it is written | when the user says yes and Windlass took the approval. "Not now" is remembered nowhere: the next message asks again |

  The same repository launched once through the connection and once by a pasted address is two projects, and is
  asked about twice. A session with no repository is its own project: its record spares it the question in a
  sandbox that replaces its own, and goes when the session is deleted.
- **A remembered approval starts the server without the question.** When Windlass reports a server that waits
  and the user's record has exactly that definition for the session's project, the session has Windlass
  approve it (`_windlass/mcp_approve`) before the prompt goes, as an answered question would, and nobody is
  asked. The timeline gets one line: "Started the MCP server "harbor" because you approved it for this project
  3 days ago: 2 tools. The agent has them from this turn on." From then on Windlass's own record in that
  sandbox starts the server, and later turns say nothing. If the user's actor does not answer within ten
  seconds, the question is put, which is never wrong.
- **Seeing an approval, and taking it back.** A session whose project names servers has a section "MCP servers"
  in its side panel: each server with its command or address in full, its state as the session last heard of
  it from Windlass (it runs and with how many tools, it waits for approval, it could not start and why), and,
  where an approval is remembered, until when, with "Forget". Forgetting removes the user's record of that
  server for the project, whatever its definition was, and the timeline says so. It holds for the next session
  and the next sandbox. It does not reach Windlass's own record: a sandbox the server already started in goes
  on starting it, and a server that is running is not stopped (Windlass's protocol has an approval and no
  withdrawal, and nothing that stops a server: `_windlass/mcp`, `_windlass/mcp_approve` and
  `_windlass/mcp_changed` are all it has). The section says this under the list. A session whose project names
  no server has no such section, unless its user has MCP servers of their own: those are listed there
  too, apart from the project's, with a state and no approval ("Account settings").
- **Approving from the panel.** A server that waits because the user said "not now" has "Approve…" there. The
  dialog shows the command and the file and says what the question says. Windlass itself takes an approval at
  any time a session is open, with or without a turn (`approveMcpServer` in its
  `packages/core/src/engine/engine.ts`, reached by `_windlass/mcp_approve`); but the platform runs one Windlass
  process per turn, and a server lives with the process that started it, so between turns there is nothing to
  start a server in. The approval is therefore recorded, and the server starts with the next turn, unasked:
  "Approved the MCP server "harbor" for this project in the session's panel. It starts with the next turn."
  While the question about that definition is open in a running turn, the panel's approval answers it, and
  the server starts at once. An approval is of the definition the panel showed: if the session has since seen
  another, it is refused and the list is to be read again.
- **Docker.** There Windlass's data is the user's volume and every session's project directory is `/workspace`,
  so Windlass's own record starts the server in all of that user's sessions where a server of that name is
  defined the same, whatever their repository, and the platform's record changes nothing until Windlass's has
  run out. The question and the panel say so there ("in all your sessions: they share Windlass's data").
- **Calling its tools.** Where Windlass sandboxes commands it asks before each call of an MCP tool, through the
  question the platform already puts. In the hardened profile the first call runs unasked; what a server
  returns is content Windlass does not trust, so from then on it asks before the commands it cannot sandbox,
  and before the next call of an MCP tool. Only for a server of the user's own can that question be
  answered by the platform, where its user said so ("Account settings").

```sh
cd server && flock /tmp/wlp-test.lock npx tsx ../scripts/mcp-check.ts   # a real Windlass in local containers, and fixtures/mcp-repo
cd server && flock /tmp/wlp-test.lock pnpm e2e                          # the session's part, on the fake layer's "(mcp...)" switches
```

`mcp-check.ts` also runs the platform's record against a real Windlass, with one Docker user per sandbox so
that each sandbox keeps Windlass's data to itself as a microVM does: a second session on a repository and a
replaced sandbox are not asked and the server runs; a changed definition, another user, another repository
that names the server the same way, the session after forgetting, and an approval past its 30 days are asked.
The end-to-end test does the same through the actors on the fake layer, with the panel's actions.

The web app's mock asks the question for a prompt with the word "mcp" in it; with "variable" too, about a
definition that cannot start; with "late" and a word about the network, while a tool call's question waits.
It remembers an approval for the session's project as the deployment does, and two of its seeded sessions
(`/agents/checks`, `/agents/harbor-build`) show the panel's section with every state of a server.
`__wlpMock.mockNextServers("list" | "approve" | "forget" | "slow")` in the console makes its next call fail,
or makes those calls slow for ten seconds.

## A repository's page

A connected GitHub repository is the project: there is no separate object for one. What the platform keeps
for a repository is kept in its user's `user` actor under GitHub's id for the repository, which a rename
does not change, in a table for each kind of thing: the setup command, the checks, the secrets, the
remembered approvals of its MCP servers, and the defaults for new sessions. Nothing is made for a repository until its user saves
something, and nothing is left once they have deleted it.

- **The list of agents is grouped** (`web/src/lib/repositories.ts`, `web/src/screens/Home.tsx`). Sessions
  stand under the repository they were launched on, the repository that was used last first, and the name
  leads to the repository's page. Sessions on no repository of the GitHub connection, a pasted address
  included, are a group of their own, last; a list with no such repository in it has no headings and reads
  as it always did. Within a group the session used last comes first. A group shows six sessions where
  there are several groups and twenty where there is one, then a line that says how many more there are
  and unfolds them; a session that is working or waits on its user is never among the hidden ones, and a
  fold that would hide one or two is not made. All of it is worked out in the browser from the summaries
  the `user` actor already broadcasts: drawing the list asks nothing of GitHub, of a sandbox provider or of
  a session.
- **The page** has two views under one tab row, each with its own address. **Work**
  (`/repositories/<GitHub's id>`, `web/src/screens/Repository.tsx`) gathers the repository's sessions, its
  work items ("Work items"), and the pull requests the sessions opened that are still open, as each
  session's summary last had them (GitHub is not asked for a list, so one merged or closed at GitHub stays
  until its session's panel next reads it), each with what its description says was verified, in a few
  words. **Settings** (`/repositories/<id>/settings`, `web/src/screens/RepositorySettings.tsx`) has the
  defaults for new sessions; the setup command and the secrets, in the same components a session's panel
  has (`SetupEditor`, `SecretsBlock`); the checks ("A repository's checks"; `ChecksEditor`); the remembered
  approvals of its MCP servers, each with when it was given, until when it holds, and "Forget"; and one
  control that deletes everything saved for the repository at once. A link opens Settings at one section
  by its fragment: `#defaults`, `#setup`, `#checks`, `#secrets`, `#servers`, `#forget`. "New agent" opens
  the launch form with the repository chosen (`/repositories/<id>/new`, or `/repositories/<id>/settings/new`
  over Settings).
- **Two questions, asked apart.** What is saved (`repository`) is the actor's own and answers at once,
  whoever can or cannot reach the repository at GitHub. Whether a session can still be launched on it
  (`githubRepository`) is GitHub's to say. So the page of a repository its user lost access to, or whose
  GitHub connection is gone, still opens, shows what is saved and lets it be changed or deleted, and says in
  one sentence that it cannot be used for new agents, with "New agent" off. When GitHub cannot be asked at
  all, the page says that nothing is known either way and offers to ask again. When GitHub does answer, what
  is saved is relabelled with the repository's current name, so the page can still name it later. A save
  for a repository that neither a session nor an earlier save names asks GitHub for the name once, for four
  seconds at most, and saves without one when GitHub does not say.
- **Defaults for new sessions** (`server/src/repository-defaults.ts`): a sandbox profile and a model. The
  launch form has no reasoning effort, so there is none to default. They are checked when they are saved,
  the sandbox against what the deployment offers and the model against the user's own models ("Models"),
  and do nothing on the server afterwards: the launch form reads them
  when that repository is picked, starts from them, and says so beside the repository, since the sandbox is
  chosen further up. A choice made in the form comes first and holds for that session only. A default that
  names a sandbox the deployment no longer offers, or a model that is not in the user's list, is left out,
  and both the page and the form say so: of a list that only stands in for the plan's, that the model is
  left out for now. Whether the agent may publish without asking is the session's own setting and is not among them.
  Where a repository saves none, the account's default holds ("Account settings"), and the page says so
  under the field.
- **Saves that run together.** The actor's actions interleave wherever one of them waits. A save of the
  defaults names the fields it changes and writes those columns in one statement, without reading the row
  first, so a save of the sandbox and a save of the model that run together both stay, and neither undoes
  a setup command or a secret saved meanwhile, which are other tables. Forgetting an approval goes through
  the approvals' own book, as a session's does.
- **Repositories with nothing but saved settings.** A repository with something saved and no session is
  not in any group, so the list of agents names those under the groups (`savedRepositories`), each a link
  to its page: nothing else leads there, and it is where a secret for a repository that was never launched
  on, or that is gone, is deleted.
- **Secrets stay write-only.** The page's own actions read no value: `repository` counts the secrets, and
  the list is the one a session's panel has.

```sh
cd server && npx tsx ../scripts/repository-check.ts   # the defaults' rules, and saves that interleave, against a SQLite database of its own
```

The web app's mock (`?mock=1`) has defaults saved for acme/harbor (`/repositories/7101`), a default model
that is no longer offered for ada/tide-tables (`/repositories/7102`), a secret and no agent for acme/quay,
and a repository the connection no longer covers with a setup command, a secret and an approval still saved
(`/repositories/7190`).

## Account settings

What a user configures for a repository holds for that repository. Three things belong to the user and
hold whatever the repository, and have a page of their own (`/settings`, from the account menu in the
top bar; `web/src/screens/Settings.tsx`): defaults for new sessions, MCP servers of the user's own, and
the secrets those servers read. All three are kept in the user's `user` actor, in tables of their own
beside the repositories', and each is read and changed by its own actions (`account`,
`saveAccountDefaults`, `savePersonalServer`, `deletePersonalServer`, `accountSecrets`,
`saveAccountSecret`, `deleteAccountSecret`). The same page has the user's API tokens, with which a script
files work items ("Work items").

### Defaults

- **What they are.** A sandbox profile and a model (`server/src/account-defaults.ts`), under the rules
  of a repository's defaults: checked when they are saved, the sandbox against what the deployment offers
  and the model against the user's own models, and doing nothing on the server afterwards.
- **The order.** The launch form goes by the user's own choice in the form, then the chosen
  repository's default, then the account's, then the deployment's first sandbox and the default of the
  user's models, each of the two fields by itself (`layerChoices`, `web/src/lib/repositories.ts`): a repository that saves only a model leaves
  the sandbox to the account. An agent on no repository, or on a pasted address, starts from the
  account's.
- **What the form says.** Beside the repository it says which defaults it stands on and whose each
  is ("This agent starts in Docker, hardened, your account's default, and on gpt-6-luna, the default
  saved for acme/harbor."), offers to take back a default its user chose over, and says of a default
  that names a sandbox the deployment no longer offers, or a model that is not in the user's list, that
  it is ignored, whose it was, and where it is changed. A repository's Settings say what a field left without a default comes to:
  the account's default where there is one.
- **Saves that run together.** As a repository's: a save names the fields it changes and is one
  statement that writes those columns, so a save of the sandbox and a save of the model both stay.

### MCP servers of the user's own

A user defines MCP servers once, and every session of theirs has them: an issue tracker, a
documentation search, whatever the repository. They are never read from a repository; a repository's
own servers are the ones in its `.windlass/config.json` ("A project's MCP servers").

- **A server** is a name and a definition, written as Windlass's own configuration takes one server
  (its docs/mcp.md): `command` with `args`, `cwd` and `env`, or `url` with `headers`, and `tools`,
  `timeoutSeconds`, `startupTimeoutSeconds`, `untrusted`, `enabled`, `protocol`.
- **Adding one** (`web/src/components/PersonalServers.tsx`). One dialog, two ways in, and the same
  stored definition from either. As JSON: the definition itself, or a snippet as a server's README
  gives it, `{ "mcpServers": { "<name>": { ... } } }`, `{ "servers": { ... } }`, Windlass's own
  `{ "mcp": { "servers": { ... } } }` or `{ "<name>": { ... } }`. From such a snippet the name and
  the definition are taken into their fields, and a line under the field says what was taken. A
  snippet that names several servers takes none: the dialog names them, and its user picks one. A
  key Windlass does not know stays the server's refusal, in its words. Or, for a server that is
  reached at an address, a form: the address and, where it needs one, one header whose value reads
  a secret of the account (`Bearer ${DOCS_TOKEN}`). It comes to `{ "url": ..., "headers": { ... } }`,
  which is what the same server is as JSON; a saved definition with more than that opens as JSON.
- **What is saved is what Windlass takes** (`server/src/personal-servers.ts`). Windlass refuses a
  configuration file with a key it does not know or a value of the wrong type, and a turn whose
  configuration is refused fails before anything is sent. So a definition is held to Windlass's rules
  key by key when it is saved, refused with the key that is wrong, and stored rebuilt from the keys
  that are known; a stored row that does not pass is not handed to a turn. The list of keys is a copy
  of Windlass's, which `scripts/account-check.ts` holds against Windlass's source when that is beside
  this repository.
- **Limits.** 20 servers for an account; a definition of at most 8,192 bytes as JSON; a name of
  letters, digits, `_`, `.` and `-`, at most 64 characters, which is Windlass's rule for one. Adding
  a server is one statement that inserts it only while the account keeps fewer than it may, so the
  limit holds between saves that run together, and none of them undoes another.
- **The platform's own server keeps its name.** No server of a user's may be called
  `windlass_platform`, or by a name that begins with it; the platform's own is written into the file
  last; and whatever the file holds under that name without the platform having put it there is
  removed. A user's definition can neither take the name nor replace the server.
- **How a session gets them** (`server/src/windlass-config.ts`, `server/src/sandbox/turn.ts`). A
  session reads its user's servers from the `user` actor when a turn starts, with the secrets, in the
  one answer. The sandbox layer writes them into Windlass's own configuration file in the sandbox
  (`~/.config/windlass/config.json`), the file the tool to publish goes into, before the turn's
  Windlass opens its session, and takes them out again when the turn has ended. What the file holds
  besides stays: a definition of the same name gives way for the turn and is put back. What the
  platform wrote is known from a list of its own beside the file
  (`~/.local/state/windlass-platform-servers.json`).
- **When a change takes effect.** With each session's next turn, also in a sandbox that exists
  already: every turn writes the list as it is then, and first takes out what an earlier turn left
  behind because its server stopped under it. A deleted server does not go on starting. A turn that
  is running keeps what it started with. The page says so under the list.
- **Windlass does not ask about them.** It asks before it starts a server a project's file names,
  and starts one its user's own configuration names without a question. So what such a server gets is
  said on the settings page, in the dialog a server is added or changed in, before it is saved, in
  the first sentence of the question about a project's server (`personalServerReach`,
  `server/src/server-question.ts`), for each sandbox the deployment can run: "It runs in a session's
  container, but outside Windlass's sandbox around commands: unlike the agent's commands, it has the
  network and can read Windlass's own data, including the session's access token, which lasts about
  an hour and cannot be renewed."
- **Its tools, with or without a question.** Calling a server's tools is another matter than
  starting it. Where Windlass sandboxes commands it asks before each call of an MCP tool, through
  the question the platform already puts; and in every profile it asks once content it does not
  trust is in the conversation, which the first result of such a server is. A server has one
  setting of the platform's beside its definition, off unless its user turns it on: its tools run
  without asking (`PersonalServer.unasked`, a column of its own, never a key of the definition).
  Windlass asks all the same. The sandbox layer answers for the user, "once" for each call, as it
  answers the question about its own tool to publish (`permission`, `server/src/sandbox/turn.ts`),
  and the session writes one line under the call: "Allowed for you without asking: your settings
  let the tools of your MCP server "tracker" run that way." (the timeline item is marked
  `question_allowed` with the call, as the publish tool's is).
  - *What is answered* is decided by fields of Windlass's own and never by the question's
    sentence. The engine's `tool.called` event of an `mcp_call` names the server and the tool. The
    question names that call (`approval.messageId`, `callId`), is the session's own and not a
    subagent's, and is about using exactly that tool and nothing else: `approval.needs` is the one
    need `{ "kind": "tool", "tool": "<server>/<tool>" }`.
  - *Whose server.* Only one this turn wrote into Windlass's configuration with the setting on,
    and which the engine holds to be its user's own (`_windlass/mcp`, `origin: "user"`). A server
    of that name which the repository's file names is the project's to Windlass, whatever its
    definition, and each call of its tools is put to the user. A sandbox whose Windlass cannot say
    whose a server is gets no answer from the platform. A server its user deleted, or switched the
    setting off for, is no longer answered for from the next turn, as its definition holds.
  - *Trust.* The setting does not say `untrusted: false`. What the server returns stays content
    Windlass does not trust: the model is told so with each result, and from the first result on
    whatever else can send data out is asked about again. Nor does the setting need it. Windlass
    drops remembered approvals once such content is in the conversation, so the platform has
    Windlass remember nothing and answers every call by itself, before that content and after. In
    `docker-hardened` and `e2b-open`, where the first call runs unasked anyway, what it answers is
    the questions from the second call on. A user who trusts a server's output as well writes
    `"untrusted": false` into its definition: that is Windlass's key, and another decision.
  - *What it risks* is said in the dialog, with what the setting does and does not do, before it
    is saved: nothing stops to ask if something the agent read talks it into misusing a tool of
    that server, and such a tool runs outside the command sandbox, with network access.
  - A subagent's call of such a tool is asked about as before.
- **A definition is no place for a credential.** It is stored as it is written, not encrypted,
  shown again on the page, written into a file in the sandbox and shown in a session's panel. The
  dialog says so, says to save a credential as a secret and to read it as `${NAME}`, and points at a
  value in `env` or `headers`, or a user name in an address, that looks written out. No log line
  holds anything of a definition: saving logs the name and whether it is a command or an address.
- **In a session's panel.** The section "MCP servers" lists the user's own under the project's, apart
  from them ("Yours, from your settings"), each with what Windlass said of it in the session's last
  turn: it runs and with how many tools, or it could not start and why. They have no approval and
  nothing to approve. A server of the same name that the project's file names is the project's, as
  Windlass has it, and is asked about, unless the repository defines it word for word as its user
  does: that one Windlass starts on the user's own word. A session lists them once it has had a turn.

### Secrets of the account

A server needs a token. The account's secrets are a repository's secrets ("A repository's secrets")
with another owner and no setup command to go to (`server/src/account-secrets.ts`).

- **Stored as a repository's.** One row per name in the `user` actor, the value sealed under the same
  key and bound to the user, the account and the name: it does not open as another user's, as a
  repository's secret of that name, or under another name. Write-only: the value comes from the
  browser once, and the listing does not read the value's column. The rules for a name and a value
  are a repository's. An account can keep 50, by one statement that holds the limit between saves
  that run together.
- **A repository's two scopes, without the setup command.** A secret of the account has the scope a
  repository's has, in the same column and under the same two values, and one rule says what
  either comes to (`secretReach`, `windlassEnvironment`): an account's secret is the repository's
  secret of that scope, except that no setup command is ever handed it. "MCP servers only" (the
  default, the repository's "setup and MCP servers"): Windlass is handed it in its environment,
  where a server's definition reads it as `${NAME}`, and it is named in `withholdEnv`, so no
  command the agent runs is given it. "Also the agent's commands": those commands get it as well,
  named in `passEnv` where its name would keep it from sandboxed ones. A project's server that reads
  the name gets it too, once its user has approved that server, and the question about such a server
  says so apart from the repository's secrets ("Its definition reads the secret TRACKER_TOKEN of your
  account, saved in your settings for MCP servers: approving gives its value to the server."). The
  scope is changed by itself, without the value, as a repository's is.
- **Where commands are not sandboxed.** The line a repository's secrets keep: a withheld variable
  can be read from Windlass's process by a command that runs as Windlass's user, so in
  `docker-hardened`, `e2b-open` and E2B before its check a secret for MCP servers only stays out
  of Windlass's environment, and a server that reads it does not start. One that is also for the
  agent's commands is handed over there too, since its user chose that those commands may read it,
  and a server that reads it starts. In a sandbox with an older Windlass a secret for MCP servers
  only is handed over only under a name Windlass keeps from commands by itself. The list on the
  settings page says what each secret reaches in the sandbox a new session starts in, and a
  session's panel says which of them its sandbox hands to servers, under a server that could not start.
- **One name, two secrets.** A session on a repository that has a secret of the same name is handed
  the repository's, with its value and its scope, and not the account's: what is saved for the one
  repository is the more particular choice, as with the defaults. Both lists say so under the secret
  ("acme/harbor has a secret of its own under this name: its agents are handed that one, with its
  scope, and not this."), and both values are taken out of what the session shows.
- **Redaction.** As a repository's: every value of the account is taken out of everything that leaves
  the sandbox layer and replaced by `[secret:NAME]`, also where it is not handed over.

```sh
cd server && npx tsx ../scripts/account-check.ts                        # the rules on their own: defaults, names, definitions, the setting, limits under saves that interleave, sealing, scopes and reach, the configuration file
cd server && flock /tmp/wlp-test.lock pnpm e2e                          # one step of its last section: through the actors, on the fake layer
cd server && flock /tmp/wlp-test.lock npx tsx ../scripts/mcp-check.ts   # its section on a user's own server: a real Windlass asks about a tool, and is answered where the setting is on
```

The web app's mock has two servers and two secrets saved for the account (`?mock=1`; `&account=empty`
for an account with nothing saved): one server that runs and whose tools run without asking, one
whose secret is not saved, a secret that is also for the agent's commands, and one under a name
acme/harbor has one of its own for. Its seeded sessions that have a sandbox list them.

## Usage and limits

A hosted sandbox costs money while it runs, so two things are limited for each user, and a page shows where they
stand (`server/src/usage.ts` has the rules, with no actor in it):

| Limit | Setting | Default |
|---|---|---|
| Sandbox time a user's sandboxes may run in one UTC day, all of them together | `WLP_DAILY_SANDBOX_SECONDS` | 7200, two hours |
| Sandboxes a user may keep at the same time, running or paused | `WLP_MAX_KEPT_SANDBOXES` | 5 |

Either takes `unlimited`. The time is counted and shown with or without a limit.

A user may also have at most `WLP_FACTORY_RUNNING_TURNS` turns running at once (default 6), their own and
their work items' together ("Work items"); the work items take at most `WLP_FACTORY_TURNS` of them
(default 5), so one is always free for the person's own prompt. A prompt beyond the ceiling is refused before
anything starts (`too_many_running`: "You already have 6 agents working, which is your limit. Wait for one
to finish, or stop one."); a work item's turn waits instead.

Only hosted sandboxes, the layer `WLP_SANDBOX` chooses, are counted. A session says where it runs
(`place` in `createSession`): hosted when left out, as is every session stored before places existed,
or one of its user's machines ("Machines of your own"). The platform's limits do not hold a machine's
sessions (`hostedLimitsApply`): their sandboxes take no sandbox time and no kept place and have no price,
and their turns do not count towards the limit on agents working at once. What bounds a machine is its
runner's own caps, which its owner may set with `--max-running` and `--max-sandboxes`, and there are none
unless they do. The usage page lists a machine's sandboxes apart, under "On your machines": "Not counted
against your daily sandbox time, running agents or kept sandboxes."

- **What is counted.** The time a session's sandbox runs: from the moment the session has it created or
  resumed, for a turn, a clone, a setup command, a push, or to read the workspace's changes, until it is
  suspended, removed, or stops by itself. So a turn counts with the time the sandbox goes on running after
  it: on E2B until its idle timeout pauses it (`WLP_E2B_IDLE_TIMEOUT_MS`, two minutes), on Docker until the
  session suspends it (`WLP_IDLE_SUSPEND_MS`, or the session going to sleep). A paused sandbox counts no
  time. It counts as one of the sandboxes its user keeps.
- **One place decides.** The user's `user` actor, which every server reaches and which does one thing at a
  time. A count kept on a server would be a limit per server.
- **A ledger.** Every second counted is in an entry in that actor's storage: which session, which hold, how
  many seconds, when, and a note where a count is not simply what was reported. A day's total is the sum of
  its entries. Nothing is ever changed in an entry; a correction is another entry. Each is also a line in
  the server's log (`[wlp] usage.counted uid=... session=... hold=... kind=used seconds=182`), to hold
  against the provider's bill.
- **Reserve, then settle.** A session does not ask whether time is left and report afterwards: two that
  asked together would both be told yes. Before its sandbox runs it takes a hold, five minutes of the day's
  allowance (`WLP_USAGE_HOLD_SECONDS`) or what is left of it, which counts as used for everyone else from
  that moment. While the sandbox runs, the session trades the hold for the next one when it is over,
  reporting what the first really ran, in one step. When the sandbox stops, the session reports what ran of
  the last hold, and the rest of it is free again. A hold never reaches past midnight UTC: the one after it
  is the new day's.
- **A hold nobody settles** runs out by itself four minutes after the time it was for, and is counted in
  full (an entry of the kind `unreported`): the server its session was on died, the sandbox ran for some
  part of the hold, and nobody measured which. A session whose server shut down in order stops its sandbox
  and reports; when the report does not get through in the two seconds a shutdown leaves, the session
  keeps it and sends it when it is next awake, and the difference is given back (`corrected`).
- **At the allowance.** A new turn is refused before a sandbox is created or started, with the code
  `allowance_used` and a sentence that says what was used, what the allowance is and when it is whole
  again: "Today's 2 h of sandbox time is used up, so nothing was started. The allowance is whole again at
  00:00 UTC, in 5 h 12 min." Less than half a minute left is too little to start with, and is said so.
  Reading a session's changes, or pushing from the panel, when that would start a paused sandbox, is
  refused the same way. A turn that is running when the allowance gives no more is stopped at the end of
  the hold it has, never in the middle of one: the timeline gets a line ("Today's 2 h of sandbox time is
  used up, so this turn was stopped at the end of the time it held. The sandbox is suspended with its files
  as they are, ..."), Windlass is asked to stop as by the Stop button, the turn ends as interrupted, and the
  sandbox is suspended, which settles its time. What it ran while stopping is counted, and the entry says
  how far past the hold that was. A sandbox that runs with no turn in it is suspended when its hold cannot
  be renewed, with a line of its own.
- **When the user's actor does not answer.** A new turn is refused (`usage_unavailable`): nothing is
  started on a count nobody could check. A turn that is running goes on and the session asks again every
  fifteen seconds; if that never works, the hold it has is counted in full when it runs out.
- **Kept sandboxes.** A session that needs a sandbox it does not have is given a place with its first
  hold, in the same step, or is refused both (`too_many_sandboxes`: "You keep 5 sandboxes, the most an
  account may have, and this agent needs one of its own. Free one on the Usage page, ..."). The place is
  given back when the sandbox is removed: after `WLP_IDLE_DESTROY_MS` without use, with its agent, or by
  the user. The platform removes none to make room by itself, because a sandbox's workspace files go with
  it. An agent can always be created; what is refused is its first prompt.
- **The count is held against what exists.** A sandbox that was never made, or one removed at the provider,
  would leave a place taken for good. So before a place is given or refused, and when the usage page is
  opened, the actor asks the provider for the user's sandboxes (Docker: by the containers' labels; E2B: by
  the metadata `wlp_uid`) and corrects the count: a place with no sandbox behind it is dropped, unless it
  is younger than five minutes and its sandbox may still be being made, and a sandbox nobody claimed is
  counted, also past the cap, since it exists. A correction is logged (`[wlp] usage.kept_corrected`): it
  means something made or removed a sandbox without the actor being told. This is apart from the
  deployment's own cap on sandboxes running at once (`WLP_E2B_MAX_RUNNING`), which stays as it was.
- **The usage page** (`/usage`, from the line under the account on the home screen): today's sandbox time
  against the allowance, with what is counted, what running sandboxes hold and what is left, and when the
  day ends in the viewer's own time zone; today by agent; the sandboxes kept, each with "Free…", which
  says what goes with the sandbox (the workspace's files that are not on GitHub) and what stays (the agent,
  its conversation and, where the deployment keeps it outside the sandbox, the agent's own memory) before
  it removes it; and the last 14 days. A sandbox left behind by an agent that no longer exists is listed
  and can be freed too. The agent whose sandbox was freed gets a new one with its next prompt, and is told
  that its workspace is a new one.
- **Before the limit.** The home screen has the day's numbers in one line. A session says so above its
  composer when less than a fifth of the allowance is left, and the launch form when the day is used up or
  no place is left.
- **The factory's limits.** The usage page also lists what the factory may run for the user at once and
  what each work item may spend, "Set by this deployment's owner", and what each item has cost so far
  against its budget ("Work items"). A work item's hosted sandbox is counted here as any other.
- **The estimated cost** is the counted seconds times the provider's published price for the size of the
  deployment's sandboxes (`server/src/sandbox/e2b/pricing.ts`), and is labelled as an estimate with that
  price. On Docker nothing is billed by the second and nothing is estimated.

Where the count and E2B's bill can differ:

| What | The count is |
|---|---|
| The session measures by its server's clock, from before it asks for a sandbox to be created or resumed until after the pause is confirmed | a second or two over per stretch |
| E2B pauses an unused sandbox at its own timeout; the session counts to the moment that timeout was due | over or under by the seconds E2B takes |
| A server dies under a running sandbox: the hold is counted in full, while the sandbox ran for a part of it and then for up to `WLP_E2B_TURN_LEASE_MS` more | over by at most a hold, or under by at most the lease |
| The user's actor cannot be reached while a sandbox runs past its hold | under by the time past the hold |
| A sandbox E2B starts and the platform discards at once (the deployment's cap, a failed set-up) | over: the seconds until the refusal are counted |
| Sandboxes the platform's own checks start, and a template build | not counted: they are no user's |
| The price: one figure per second, for the size E2B last reported | an estimate either way |

On Docker a container that goes on running after its server died is not counted from the moment its hold
runs out until the session wakes, takes a new hold and suspends it. Nothing is billed there.

```sh
cd server && npx tsx ../scripts/usage-check.ts    # the rules on their own: holds, the day, reports, kept sandboxes, the count against the provider
```

The web app's mock plays a deployment with the default allowance and room for twenty sandboxes
(`?mock=1`), with a day's history that has one day at the limit; `&usage=low`, `&usage=used` and
`&usage=full`, or `__wlpMock.mockUsage(...)` in the console, play a day with little left, a day that is
used up and an account with no place left.

## Work items

A work item is a task on one repository of the user's GitHub connection that the platform carries from the
start to a pull request by itself: a title, a description, and acceptance criteria, which are for the
person to check and which the verdict lists. Each item has an agent session of its own, listed with the
user's other agents, that only the item's steps send prompts to ("This agent works for a work item, whose
steps send its prompts. Answer the item, or send its work back with a note.") and that cannot be deleted
while the item has it; the item is cancelled instead, and the agent and what it did stay readable. An
item is filed on its repository's Work view ("New work item…") or through the API below, and has a page
of its own (`/items/<id>`) with its step, its log, its verdicts and its cost. The home screen lists, under
"Needs you", every item that asks its person something.

- **The sequence is fixed** (`server/src/factory/blueprint.ts`). Which step comes next is decided from what
  the platform observed, never from what the agent says. The agent implements the task in one turn. The
  turn's own verification, the user's checks for the repository ("A repository's checks"), decides what
  follows: a check that failed sends the agent back to fix it, at most twice in a run. Then the platform
  pushes the item's branch and opens the pull request; a push that does not get through for a network
  error is tried three times, and one GitHub refuses is a question with GitHub's reason. It waits for CI with
  the sandbox paused, reading it every minute, or every three minutes while the user has more than ten
  items open; no check run and no status ten minutes after the push means the repository has no CI. It
  gives the agent CI's failing checks and the end of their logs, at most twice in a run. A pull request
  that GitHub says conflicts with its base gets one turn to merge the base. Then the item is handed to its
  person with a verdict and is in review, and the platform reads the pull request every ten minutes until
  it is merged (the item is done) or closed (cancelled).
- **The platform never merges.** Nothing in the sequence merges a pull request, and no verdict does: the
  person merges at GitHub, or sends the work back from the item's page with a note, which starts a new run.
- **Turns are unattended.** An item's turn has nobody to ask: a tool call that would ask is refused at once,
  and the model is told so. A turn takes at most 60 steps. The agent is not given the tool to publish,
  since the platform pushes an item's work itself; it is given one, `report`, to file what it did, in a
  title and a description that the platform puts on the pull request, and what it is unsure of.
- **Every stop is a question.** The rounds above used up, the same failure again after a fix, a turn that
  changed nothing, a push GitHub refused, CI still running 90 minutes after the push, a step whose turn was
  cut off three times (by a deploy or a restart), or the item's budget used up: the item waits for its
  person, for days if need be, with the reason and the choices that fit it ("Raise the limit and go on",
  "Retry from scratch", "Hand it over as it is" once there is a pull request, "Give up").
- **The verdict** is what the work at the pushed commit rests on, made from what the session's gate
  recorded, the observations on the changes ("What a pull request shows was verified") and CI at that
  commit, never from the agent's words (`server/src/factory/verdict.ts`). `fail`: a check of the gate's
  run or CI failed; `incomplete`: the turn was stopped, failed or was cut off; `unverified`: nothing
  verified this state of the work; `pass` otherwise. A pass with observations is shown as needing a look.
- **Limits are waits.** Nothing is refused for lack of room. An item that cannot go on now waits and says
  for what, with its numbers ("Waiting for one of your 5 factory turns; 5 are running (…)."): a free turn,
  a free place among the kept sandboxes, the day's allowance (until 00:00 UTC), one of the user's hosted
  sandboxes running at once, the deployment's cap on running sandboxes, or fewer of the user's items in
  review, which holds back new work and never work in progress. A request is tried again when a turn is
  given back or one of the person's own agents goes idle, and otherwise after 30 seconds, then twice as long
  each time up to five minutes. Requests are taken oldest first, and an item has at most one turn
  waiting, so the items take turns.
- **The same ceiling as the person's own agents.** `WLP_FACTORY_RUNNING_TURNS` counts the person's own
  turns and the items' together, and is the ceiling on the person's own running agents ("Usage and
  limits"). The items' share, `WLP_FACTORY_TURNS`, is held at least one below it (unless the ceiling is
  1), so a person's own prompt never waits behind the factory.
- **The cost of an item** is its tokens, turns, working time and hosted sandbox time, against its budget, on
  the item's page and the usage page. Working time leaves out what it waited for. A budget used up is a
  question, and "Raise the limit and go on" takes the person's new figures for that item.

The limits are the deployment's, the same for every user, set by its owner; a user cannot raise them. A
setting that is not a whole number in its range stops the server when it starts.

| Limit | Setting | Default |
|---|---|---|
| A user's turns running at once, their own and their items' together | `WLP_FACTORY_RUNNING_TURNS` | 6 (at most 100) |
| Of those, the items' | `WLP_FACTORY_TURNS` | 5; one set higher is held to one less than `WLP_FACTORY_RUNNING_TURNS`, and to 1 at least |
| The user's hosted sandboxes running at once beside which an item's turn may start | `WLP_FACTORY_HOSTED_RUNNING` | 3 |
| Items in review at which new items wait | `WLP_FACTORY_REVIEW_CAP` | 6 |
| A new item's budget: tokens, turns, working seconds, hosted sandbox seconds | `WLP_FACTORY_ITEM_TOKENS`, `WLP_FACTORY_ITEM_TURNS`, `WLP_FACTORY_ITEM_ACTIVE_SECONDS`, `WLP_FACTORY_ITEM_HOSTED_SECONDS` | 4,000,000 tokens, 10 turns, 14400 (4 hours), 5400 (1.5 hours) |

An item's hosted sandbox counts against the user's daily allowance and kept sandboxes as any other ("Usage
and limits"), whose defaults are sized for a few agents by hand, not for many items a day.

**The API.** A script files and reads items with an API token, sent as `Authorization: Bearer wlp_…`. A user
makes one on their Settings page (`/settings`), under "API tokens", with one or both scopes,
`items:create` and `items:read`; its value is shown once, the platform keeps only its SHA-256 digest
(`server/src/api-tokens.ts`), and it works until it is revoked there. An account keeps at most 20.

```sh
curl -X POST https://<name>.onrivet.dev/api/items \
  -H "Authorization: Bearer $API_TOKEN" -H "Idempotency-Key: $(uuidgen)" -H "content-type: application/json" \
  -d '{"repository":{"id":123456789},"title":"Fix the light","body":"...","acceptance":["The light turns off"],"start":true}'
curl https://<name>.onrivet.dev/api/items/<id> -H "Authorization: Bearer $API_TOKEN"
```

`POST /api/items` takes what the web app's form sends (`CreateItemInput`): `repository.id` is GitHub's id
for a repository of the user's connection, `branch` beside it names the base (the default branch when left
out), and `start: true` starts the item at once; without it the item is a draft until it is started. It
answers 201 with the item's summary. `GET /api/items/<id>` answers 200 with the item's page (`ItemView`).
The `Idempotency-Key` header is the creation's key, by the rules of "A message sent twice": the same key
with the same body answers with the item the first attempt made, and with another body it is refused (409,
`idempotency_key_reused`). A token that is not valid, or lacks the scope, is answered 401, `invalid_token`;
every error is `{ code, message }`, with the codes of the web app's actions.

**CI needs the GitHub App's three read permissions** ("The GitHub App"). Without them, or before an
installation has accepted them, an item waits for no CI: it is handed over saying that CI was not read.

What is not in this slice. Items run on hosted sandboxes only: one filed for a machine is refused
(`bad_input`). Nothing of an item is pushed before the step that opens its pull request. At the handover
the platform asks nobody to review the pull request and writes no comment on it; the person finds it on
the item's page and on the repository's Work view. Until the next Windlass release, in a profile where
Windlass 0.3.0 asks before a call of an MCP tool (`docker-windlass-sandbox`, E2B with its sandbox
promised), an item's agent is told that its report was not taken, since nobody is there to allow the
call, although the platform has received it; in the profiles where Windlass asks nothing, it is told the
report was taken. There is no planning step: an item starts by implementing. Items come from the web app
and the API, from their own user, and nothing is taken in from GitHub's issues.

```sh
cd server && npx tsx ../scripts/factory-check.ts                          # the sequence, verdicts and budgets as tables of facts, and the reader of CI against the GitHub stand-in
cd server && flock /tmp/wlp-test.lock npx tsx ../scripts/factory-e2e.ts   # items through the real actors, on fake sandboxes and the GitHub stand-in; ports 6620, 6621, 6630 and 6645
```

## Layout

| Path | What it holds |
|---|---|
| `server/src/contract.ts` | The contract between the actors and the web app: types only |
| `server/src/actors/` | The actors: `login`, `user`, `agentSession`, `machine`, `machinePairing` with `pairingDirectory`, and `workItem`. `user-machines.ts` and `user-items.ts` hold what the `user` actor does for machines and for work items (the index, the turn queue, the API tokens), `session-inbox.ts` what a session does for its item |
| `server/src/index.ts`, `platform-info.ts`, `runner-routes.ts`, `api-routes.ts` | The server: one Rivet node, and its HTTP routes (`/platform/info`, `/platform/connection`, `/health`, GitHub's callback, the runner's three, the API's two) |
| `server/src/web.ts` | The web app's built files, served on the same port where `WLP_WEB_DIR` names them |
| `server/src/connection-tokens.ts` | The tokens browsers connect with: issued by the engine for the admin token, kept and handed out by each server |
| `server/Dockerfile` | The server as an image, for a Rivet Cloud cluster or a machine of your own ("Running on several servers") |
| `server/src/sandbox/api.ts` | The sandbox layer's interface; everything about Docker and the `windlass` command line is behind it |
| `server/src/sandbox/` | That layer on Docker: containers, volumes, running a turn, the hand-off of an access token to a turn, the demo scripts |
| `server/src/signin/` | The ChatGPT sign-in for every layer: Windlass's sign-in commands and where they run, the encryption, and the one place per user that asks for an access token |
| `server/src/sandbox-fake.ts` | The same interface in memory, for tests |
| `server/src/server-question.ts` | The words of the question about a project's MCP server, for each sandbox profile, and of the timeline's lines about it |
| `server/src/server-approvals.ts` | The user's remembered approvals of projects' MCP servers: what a project is, the record itself, and what a session keeps of its project's servers for its side panel |
| `server/src/submissions.ts` | A submission and its key: what a key may be, what is held against it, and how an attempt that arrives while another is being decided ends as that one does ("A message sent twice") |
| `server/src/usage.ts` | A user's sandbox time and kept sandboxes: what is counted, the two limits, the book the `user` actor decides with, and the words of a refusal ("Usage and limits") |
| `server/src/setup-command.ts`, `server/src/sandbox/setup.ts` | A repository's setup command: what it is saved for, its limits, what is kept of a run's output and what the agent is told; and the run itself in a sandbox |
| `server/src/repository-defaults.ts` | A repository's defaults for new sessions: what may be saved, and how a save writes only the fields it names ("A repository's page") |
| `server/src/repository-checks.ts` | A repository's checks: what may be saved, the list as Windlass takes it (as required checks, or as its own file's), and how it is stored whole ("A repository's checks") |
| `server/src/verified.ts` | What a session's work was verified with: what a turn's events come to, what is looked for in the work's changes, and the section of a pull request's description ("What a pull request shows was verified") |
| `server/src/account-models.ts` | The models a user may choose ("Models"): the list of their ChatGPT plan as the `user` actor keeps it, when Windlass is asked again, the stand-in, and how a model and an effort are held against the list |
| `server/src/account-defaults.ts`, `server/src/personal-servers.ts`, `server/src/account-secrets.ts` | What a user keeps for their account ("Account settings"): the defaults for new sessions; their own MCP servers, what a name and a definition may be and how many are kept; and the secrets those read, whom they reach and how they give way to a repository's |
| `server/src/windlass-config.ts` | Windlass's own configuration file in a sandbox: what the platform writes into it for a turn (the user's own MCP servers, the tool to publish, the repository's checks), how it is taken out again, and what a repository's own file says about checks, and that wake-ups are off (`wake.enabled: false`) for every session, since nothing delivers one while a sandbox is paused |
| `server/src/agent-publish.ts` | The agent asking the platform to publish: the tool and its server, what a request may hold, and the words of the question, of the timeline's lines and of what the agent is told |
| `server/src/repo-secrets.ts` | A repository's secrets: what may be saved, what a scope comes to in each kind of sandbox, the sealing, and taking saved values out of text |
| `server/src/bucket/`, `server/src/sandbox/backup.ts` | The object store the copies of Windlass's session data go to (S3 protocol, and a stand-in for tests), and what is copied, saved and restored |
| `server/src/github/` | The GitHub App: its tokens and API calls, connecting (the callback route), which repositories a user may work on, the git commands the platform runs in a sandbox ("GitHub"), and the reader of a commit's CI (`ci.ts`) |
| `server/src/runner/` | What the server and the runner share: a session socket's protocol and its resumable channel (`protocol.ts`, `channel.ts`), the control socket's frames and refusals (`control.ts`), and the checks both are built from (`check.ts`) |
| `server/src/machines/`, `server/src/sandbox/runner-layer.ts`, `server/src/runner-keys.ts` | A machine on the server: the one-use tickets of a session's socket and the profiles a machine offers from its report; the session's link to its runner, and what the session says when the machine does not answer; the pairing codes, and the machine keys and their signatures ("Machines of your own") |
| `server/src/factory/` | Work items as pure modules: the fixed sequence (`blueprint.ts`), the verdict, the budgets and waits, and the types they share ("Work items") |
| `server/src/api-tokens.ts` | The API's tokens: how one is made, kept as a digest, checked and revoked |
| `sandbox/` | The sandbox image, `build.sh`, `cleanup.sh` |
| `runner/` | The runner program for a user's machine (Node, bundled with esbuild into one file by `bundle.mjs`), and its `Dockerfile`; `scripts/runner-build.sh` builds the image |
| `web/` | The web app (Vite, React); `src/api/rivet.ts` is the real client, `src/api/connection.ts` where it gets its connection and renews its token, `src/api/mock.ts` the mock |
| `fixtures/windlass-events/` | Recorded Windlass events, used by the fake layer, the mock and the reducer's tests |
| `fixtures/mcp-repo/` | A small repository whose `.windlass/config.json` names an MCP server, and the server (Python, nothing else), for `scripts/mcp-check.ts` |
| `scripts/` | `dev.sh`, `e2e.ts` (the actors), `sandbox-check.ts` (the sandbox layer), `signin-check.ts` (the sign-ins), `connection-check.ts` and `connection-e2e.ts` (what browsers connect with, and its renewal), the stand-ins the checks use (`github-standin.ts`; `runner-fake.ts` and `runner-stub-server.ts` for a runner and for the platform), and the checks listed under "Checks" |

## Checks

```sh
pnpm -r typecheck
pnpm --filter @windlass-platform/web test                         # the timeline reducer against every fixture; the connection and its renewal
cd server && pnpm e2e                                             # the actors, fake sandboxes
cd server && WLP_DEMO=1 pnpm e2e:docker                           # the actors, real containers
cd server && npx tsx ../scripts/sandbox-check.ts                  # the sandbox layer on its own
cd server && npx tsx ../scripts/mcp-check.ts                      # the question about a project's MCP server, against a real Windlass
cd server && npx tsx ../scripts/setup-check.ts                    # a repository's setup command: its rules, no server and no Docker
cd server && npx tsx ../scripts/usage-check.ts                    # sandbox time and kept sandboxes: their rules, no server and no Docker
cd server && npx tsx ../scripts/secrets-check.ts                  # a repository's secrets: its rules, no server and no Docker
cd server && npx tsx ../scripts/repository-check.ts               # a repository's defaults: its rules and saves that interleave, no server and no Docker
cd server && npx tsx ../scripts/verified-check.ts                 # a repository's checks and what a pull request says was verified: the rules, no server and no Docker (--docker: a real Windlass)
cd server && npx tsx ../scripts/account-check.ts                  # the account's settings: defaults, own MCP servers and their secrets, no server and no Docker
cd server && npx tsx ../scripts/idempotency-check.ts              # a message sent twice: with and without a key, through the actors on fake sandboxes, on ports of its own
cd server && npx tsx ../scripts/models-check.ts                   # a user's models: the list's rules, and the real `windlass --models` against a stand-in for the provider
cd server && npx tsx ../scripts/signin-check.ts                   # the sign-in machinery: no server, no Docker, a stand-in for OpenAI
cd server && npx tsx ../scripts/connection-check.ts               # the tokens browsers connect with: a stand-in for the engine
cd server && npx tsx ../scripts/access-check.ts                   # who may sign in: the invitation list and the demo
cd server && npx tsx ../scripts/web-files-check.ts                # the web app's files as the server serves them
cd server && npx tsx --tsconfig ../web/tsconfig.json ../scripts/connection-e2e.ts
                                                                  # the web app's client through an engine whose tokens run out
```

The checks of machines and of work items run from `server/` too, except `runner-check.ts`, whose header
has it run from the repository root after `scripts/runner-build.sh` has built the runner's image.

```sh
npx tsx ../scripts/runner-protocol-check.ts                    # the runner channel under the failures it will meet, on loopback sockets and a clock moved by hand
npx tsx ../scripts/runner-control-check.ts                     # the control socket's frames: input that is not a frame, every refusal readable by a runner, a second runner with one key
flock /tmp/wlp-test.lock npx tsx ../scripts/machine-check.ts   # pairing, keys, removal and the 90-day expiry, through the real routes and actors, a second node and the runner's own control loop. Ports 6850, 6851, 6860, 6870 and 6871
npx tsx ../scripts/runner-e2e.ts                               # sessions on a machine through the real server and actors, with a runner stood in for in the process; no Docker. Ports 6950, 6951, 6960 and 6970
pnpm exec tsx ../scripts/runner-socket-probe.ts                # one throwaway actor on a local engine, ports 6740, 6741 and 6750
npx tsx ../scripts/factory-check.ts                            # work items' sequence, verdicts and budgets as tables of facts, and the reader of CI against the GitHub stand-in
flock /tmp/wlp-test.lock npx tsx ../scripts/factory-e2e.ts     # work items through the real actors on fake sandboxes and the GitHub stand-in; ports 6620, 6621, 6630 and 6645
```

```sh
scripts/runner-build.sh                                                            # the runner's image, windlass-runner:dev, from the local sandbox image
flock /tmp/wlp-test.lock server/node_modules/.bin/tsx scripts/runner-check.ts      # the real runner in real containers, against a stand-in of the platform and the real routes: pairing, outages, refusals, prune. Ports 6900, 6901, 6910, 6920, 7020, 7021 and 7030
```

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

`pnpm e2e` and `pnpm e2e:docker` start their own server on ports 6420 and 6440, so stop a running one first; the other scripts that start a server use ports of their own, named above where they bind any.

## Configuration

| Variable | Effect |
|---|---|
| `WLP_DEMO` | `1`: offer the demo sign-in (scripted model). `scripts/dev.sh` sets it |
| `WLP_ALLOWED_EMAILS`, `WLP_ALLOWED_USERS` | who may sign in with ChatGPT: account emails and user ids (`u_...`), comma-separated. Unset, both: anyone with a ChatGPT account. Asked at the sign-in and at every call, so a removal holds at once |
| `WLP_SANDBOX` | `docker` (default), `e2b` ("E2B") or `fake` |
| `WLP_SECRET` | signs tokens; when unset one is generated in `.data/secret`. Required with a remote engine (`RIVET_ENDPOINT`): the server refuses to start without it |
| `WLP_WEB_ORIGINS` | origins the web app may connect from, comma-separated (default `localhost:5173`, `127.0.0.1:5173`) |
| `WLP_TURN_TIMEOUT_MS` | how long one turn may run (default 45 minutes). The durations that keep its access token fresh are constants and hold for a turn of any length |
| `WLP_LOGIN_TTL_MS` | how long a sign-in attempt stays open (default 10 minutes) |
| `WLP_QUESTION_TIMEOUT_MS` | how long a question waits for an answer before the platform declines it (default 10 minutes) |
| `WLP_SERVER_APPROVAL_TTL_MS` | how long an approval of a project's MCP server is remembered for its user (default and most: 30 days, which is how long Windlass keeps its own). A shorter time is for the checks |
| `WLP_SETUP_TIMEOUT_MS` | how long a repository's setup command may run in a new sandbox before the platform stops it (default 10 minutes); the same on every server |
| `WLP_IDLE_SUSPEND_MS` | how long after a session's last turn ended its sandbox is suspended (default 10 minutes) |
| `WLP_IDLE_DESTROY_MS` | how long after its last use a sandbox is removed with its files; the timeline stays (default 7 days). E2B keeps a paused sandbox for as long as it is not killed and does not bill it, so a deployment there can set this to years: then a sandbox goes only with its agent |
| `WLP_DAILY_SANDBOX_SECONDS` | how many seconds a user's sandboxes may run in one UTC day, all of them together (default 7200, two hours; at least 60), or `unlimited` ("Usage and limits") |
| `WLP_MAX_KEPT_SANDBOXES` | how many sandboxes a user may keep at the same time, running or paused (default 5), or `unlimited` |
| `WLP_USAGE_HOLD_SECONDS` | how much of the day's allowance a running sandbox reserves at a time, and so how often its session reports (default 300, from 5 to 3600). A shorter time is for the checks |
| `WLP_FACTORY_RUNNING_TURNS` | how many turns a user may have running at once, their own and their work items' together (default 6, from 1 to 100): also the ceiling on the user's own running agents ("Work items") |
| `WLP_FACTORY_TURNS` | how many of those a user's work items may take (default 5, from 1 to 100); held to one less than `WLP_FACTORY_RUNNING_TURNS` |
| `WLP_FACTORY_HOSTED_RUNNING` | how many of a user's hosted sandboxes may run at once for a work item's turn to start beside them (default 3) |
| `WLP_FACTORY_REVIEW_CAP` | how many of a user's work items may be in review before new ones wait (default 6) |
| `WLP_FACTORY_ITEM_TOKENS`, `WLP_FACTORY_ITEM_TURNS`, `WLP_FACTORY_ITEM_ACTIVE_SECONDS`, `WLP_FACTORY_ITEM_HOSTED_SECONDS` | a new work item's budget: tokens, turns, seconds of working time and seconds of hosted sandbox time (defaults 4000000, 10, 14400 and 5400) |
| `WLP_BUCKET_ENDPOINT`, `WLP_BUCKET_NAME`, `WLP_BUCKET_ACCESS_KEY_ID`, `WLP_BUCKET_SECRET_ACCESS_KEY` | the S3 bucket that keeps a copy of each agent's Windlass session where sandboxes are E2B's ("The agent's memory outlives its sandbox", which has the optional ones too). Unset: no copy is kept |
| `WLP_BACKUP_MAX_BYTES` | the largest copy that is kept (default 64 MiB) |
| `WLP_FAKE_BACKUP_DIR` | fake layer only: a directory that stands in for the bucket; the fake sandboxes then hold Windlass's sessions as E2B's do |
| `WLP_FAKE_RESERVE_FAULT` | fake layer only, for `scripts/e2e.ts`: makes the answers between a session and its user's actor about sandbox time go wrong (`lose:<n>`, `lose-renewal:<n>`, `down:<ms>`, comma-separated) |
| `WLP_HTTP_PORT` | the port of the server's own routes ("Running on several servers" lists them; default `PORT` when that is set, else 6440) |
| `WLP_WEB_DIR` | the web app's built files (`web/dist`), for the server to serve on that port; unset, it serves none. `server/Dockerfile` sets it |
| `WLP_HTTP_HOST` | the address they bind (default `127.0.0.1` with the local engine, `0.0.0.0` with a remote one) |
| `RIVET_ENDPOINT`, `RIVET_NAMESPACE`, `RIVET_TOKEN`, `RIVET_POOL`, `RIVET_NODE_VERSION` | RivetKit's own: the engine to join instead of starting a local one ("Running on several servers") |
| `RIVET_RUN_ENGINE_PORT` | RivetKit's own: the port of the local engine it starts (default 6420), for a second development server on one machine. The engine also binds the port after it and the tenth after it; the web app is then built with `VITE_WLP_ENDPOINT` naming it |
| `WLP_PUBLIC_ENDPOINT` | the Rivet endpoint browsers connect to, which the server tells the web app. Unset: the web app uses `VITE_WLP_ENDPOINT` |
| `RIVET_ADMIN_TOKEN` | the engine's admin token, a secret: the server issues the short-lived tokens browsers connect with. Needs `WLP_PUBLIC_ENDPOINT`. Unset, as with the local engine: browsers are handed no token |
| `WLP_CONNECTION_TOKEN_TTL_MS` | how long such a token lasts (default one hour; from one minute to 24 hours) |
| `WLP_GITHUB_APP_ID`, `WLP_GITHUB_APP_SLUG`, `WLP_GITHUB_CLIENT_ID` | the deployment's GitHub App: its id, its name as its address has it, its client id ("GitHub"). With these and the two below, users can connect GitHub; with none, nothing of GitHub is offered |
| `WLP_GITHUB_CLIENT_SECRET`, `WLP_GITHUB_PRIVATE_KEY` | the app's client secret and private key, both secrets. The key as the `.pem` file has it, with `\n` for its line breaks, or in base64 |
| `WLP_GITHUB_API_URL`, `WLP_GITHUB_URL` | GitHub's API and GitHub itself (defaults `https://api.github.com` and `https://github.com`) |
| `WLP_MACHINES` | `1`: users may pair machines of their own ("Machines of your own"); default off |
| `WLP_PUBLIC_URL` | the platform's address for runners: an `https://` origin, or `http://` on a loopback address. Required with `WLP_MACHINES=1` and a remote engine; with the local one, default `http://localhost:<WLP_HTTP_PORT>` |
| `WLP_RUNNER_IMAGE` | the runner image the Machines page names, `<name>@sha256:<64 hex>`; unset: none is published yet |
| `WINDLASS_BINARY` | the executable `sandbox/build.sh` puts in the image (default: the local build with `login token --valid-for`, see "Run it") |
| `WLP_SANDBOX_IMAGE` | `sandbox/build.sh` only: another tag for the image it builds, for a throwaway image; the server always uses `windlass-platform-sandbox:latest` |
| `VITE_WLP_ENDPOINT` | the Rivet endpoint the web app connects to when the server names none, as a development server does (default `http://localhost:6420`). A server with `WLP_PUBLIC_ENDPOINT` names its own, and this is not needed |
| `VITE_WLP_API` | where the web app asks for `/platform/info` and `/platform/connection` (default: the endpoint's host on port 6440 when the endpoint is on 6420, else `http://localhost:6440`) |
| `VITE_WLP_MOCK` | `1`: the web app runs on its mock, with no server |

A duration (`WLP_..._MS`) that is set and is not a number of milliseconds the platform can use stops the
server when it starts, with one line that names the variable (`[wlp] WLP_IDLE_SUSPEND_MS must be a number
of milliseconds of at least 1000, or not set for its default.`). One that is not set takes its default.
A count (`WLP_DAILY_SANDBOX_SECONDS`, `WLP_MAX_KEPT_SANDBOXES`, `WLP_USAGE_HOLD_SECONDS`, the `WLP_FACTORY_*`
settings) that is not a whole number in its range stops the server the same way.

Actor data is in `.data/.rivetkit`; stop the server and remove that directory to start from nothing.
`sandbox/cleanup.sh --keep-image` removes every container and volume this project made, sign-ins of the first
version that were never taken in included; the sign-ins in the users' actors go with the actor data.

A platform that was used before sign-ins were kept in the users' actors still has them in Docker volumes;
"Sign-ins" says how they are taken in. An agent made before sign-ins left the sandboxes keeps its sandbox, which was made from the older
image: its files and its timeline are there, and demo agents go on working, but its Windlass cannot run on a
handed-in token, so a prompt on a ChatGPT sign-in ends by saying so and asking for a new agent. An agent whose
sandbox was made from an image whose Windlass does read a handed-in token goes on working after the image is
rebuilt, also when that Windlass is older than the codes ("What went wrong with a token" above), and when it
is older than the session's home and the lists of variable names ("Sandboxes that keep an older Windlass").

## Limits

- **It is a development deployment.** The local Rivet engine accepts anyone who can reach port 6420, and its
  control-plane token is a fixed default. Do not expose it.
- **ChatGPT sign-in for a hosted service needs OpenAI's agreement.** The flow used here is the one OpenAI
  documents for open-source, self-hosted apps.
- **The hardened profile does not ask about commands.** Windlass runs there with `--approval full`, since without
  its own sandbox every command would otherwise need an answer. Two exceptions: it asks before starting a
  project's MCP server, and after an MCP server's first result, which it does not trust, it asks about commands
  again ("A project's MCP servers").
- **A key covers a prompt and the making of an agent, and nothing else.** The other actions set a value,
  or go by something the call names (a question's id, a ticket, a secret's name), so a repeat does nothing
  a second time; some of them answer a repeat with a refusal where the first attempt had succeeded
  (`answer`: `no_question`; `deleteSession`: `session_not_found`; a new MCP server: `server_exists`). `stop`
  names no turn, so one that arrives late stops the turn that runs then. And three things a key does not
  mend: a server killed between the write of a message and the write of the session's state forgets that
  message's key, as it forgets that the turn was counted; a message Windlass admitted into a turn in the
  moment that turn ended is refused, and sent again it starts a turn; and a sign-in whose answer was lost
  has to be started again.
- **Signing out forgets the token in the browser only.** The token is good for 30 days, but an account taken off
  the invitation list, or a demo user once the demo is off, is refused at every call (`server/src/access.ts`).
- **Each demo sign-in leaves a small volume** until `sandbox/cleanup.sh` runs.
- **A user's limits are per account, and the demo makes accounts.** Every demo sign-in is a user of its
  own, with a day's allowance and five places of its own, so where the demo is on, the two limits bound
  what one account uses and not what a visitor does. What bounds that is the deployment's own cap on
  sandboxes running at once (`WLP_E2B_MAX_RUNNING`).
- **Sandbox time is counted, not billed.** The count is the session's own measurement, and differs from
  the provider's bill by seconds in ordinary use and by up to a hold when a server dies ("Usage and
  limits" has the cases). Nothing compares the two by itself: the log has one line per entry, and E2B's
  usage page has what was billed.
- **What a machine reports is what the platform shows.** A session on a user's own machine runs its checks
  there, and its pull request's section says that this is what that machine reported. The platform does
  not control the machine: whoever runs it can change what runs there and what it reports, and can read
  what its sessions are handed (the repository, the saved secrets it is sent, a turn's access token).
- **A machine that is offline when its user forgets the ChatGPT sign-in is never told.** The runners that
  are connected then remove the token files of running turns; an offline one keeps what it has until each
  token expires, within the hour ("Machines of your own" says how its owner removes them sooner).
- **Pairing has one budget for the deployment.** The routes a runner calls see no client address they
  could trust, so the pairings that are started are limited per machine key and in 64 groups a key cannot
  choose. Someone who makes many keys can use up the deployment's starts for ten minutes; the machines that
  are paired already are not affected.
- **A machine's sandboxes are not removed by the platform.** Their disk is the machine's: the runner stops
  an idle sandbox and removes one only when asked, with its agent, with the machine's removal, or by
  `prune`.
- **The runner pins one sandbox image, and no runner image is published.** A new sandbox image means a
  new runner build, and until one is published a machine runs only a runner built there from a local
  sandbox image (`scripts/runner-build.sh`).
- **A day's allowance at the time it was used is not kept.** The history marks a day as at the limit by
  today's allowance, so after the setting changes an earlier day may be marked that was not at its limit
  then, or not marked that was.
- **A server that stops can leave a sandbox running for a few minutes.** A session has 4 of the shutdown's
  20 seconds to suspend its sandbox ("When a server stops"); one that takes longer is paused by E2B at its
  own timeout, at most three minutes later, and billed until then (about $0.003 at the default size). A
  turn that does not close itself in 10 seconds is ended as interrupted when the session next wakes.
- **A deleted session's copy can outlive it.** When the bucket refuses its removal for about four hours, the
  platform gives up and names the object in the log; removing it is then the bucket's keeper's to do.
- **A browser's connection token cannot be withdrawn.** Whoever asks a server gets one, and it is good until it
  expires, an hour by default, for creating, listing, reading and calling this deployment's actors; what an
  actor then does for its caller is decided by the platform's own sign-in, as before. RivetKit's client puts
  the token in the address of some requests (`rvt-token`, or after the actor's id), where a proxy's log may
  keep it. A server whose token the engine refuses for another reason than its age goes on handing it out
  until half of its life is gone, or until the server is restarted.
- **An access token that was handed out stays valid until it expires.** Forgetting a sign-in removes it and the
  token files of running turns, but a token a command already read in the hardened profile works for the rest of
  its hour.
- **The test suites never call E2B.** They run the E2B provider on a stand-in for E2B's service. Only
  `scripts/e2b-check.ts` runs it against the real one ("E2B"): one sandbox for under a minute; and
  `scripts/e2b-backup-check.ts`, two for under half a minute.
- **A lost sandbox's files stay lost.** What comes back is the agent's memory of the conversation, not the
  workspace: the agent remembers files that are no longer there, and finds that out when it looks. A
  repository the session was launched with is cloned again.
- **A copy of an agent's memory is as private as its bucket.** It is not encrypted by the platform, and a
  server that dies in the moment between an upload and the write of its record leaves a copy the session
  does not recognise: a sandbox lost before the next turn's save then starts without its memory.
- **Daytona, Firecracker and agentOS are listed, not built.** Daytona does not wait on Windlass: a session on
  another machine would be handed a short-lived access token as the other sessions are. It needs a provider in
  the sandbox layer, an image with Windlass in it and an account. Firecracker needs a host with KVM and a guest
  agent; agentOS cannot run the Windlass executable at all.
- **Where commands are not sandboxed, a command can ask to publish in the agent's name.** It runs as
  Windlass's user and can write on the engine's connection to the platform. The platform therefore asks the
  user about every request in those profiles and never publishes unasked there ("The agent asks to
  publish"), so a task that is to publish while its user is away needs a profile whose commands Windlass
  sandboxes. What would close it: an engine that runs as another user than its commands, or one whose
  connection a command cannot write to.
- **In a sandbox that still has Windlass 0.2.0, a repository's own file can replace a user's checks,
  and the platform can only say so.** Windlass 0.2.0 follows `checks` and `verify` in a repository's
  `.windlass/config.json` before its user's, and an agent can write that file: from the turn after, its
  list runs in place of the user's, or nothing does. The pull request then says that the checks that
  ran were the repository's, that the user's did not run, and that the check configuration changed in
  this work; nothing stops the turn from being called done. In a sandbox whose Windlass has required
  checks the user's run whatever that file says ("A repository's checks"): that is 0.3.0, which every
  sandbox made from the image as it is now has. And the observations about a work's changes are a short list of
  patterns: they miss a test deleted from inside its file and a check weakened in a way the list does
  not name, and they have not been run on a large repository.
- **Work items take only their person's words.** Items come from the web app and the API, from their own
  user, and the agent is given the text as its prompt. There is no intake from GitHub's issues and no
  planning step, and an item runs on hosted sandboxes only.
- **An item's verdict is as good as its repository's checks and CI.** The acceptance criteria are listed
  for the person and checked by nobody, and a repository with no checks of its user's and no CI is
  handed over `unverified`.
- **A pull request's section is as old as the last push.** It is written when the platform pushes, and
  once more after a turn in which the agent published. A turn that changes files and is not pushed
  leaves the description saying what was true of what is at GitHub.
- **What a turn wrote into Windlass's configuration can outlast it until the next turn.** The tool to
  publish, the repository's checks and the user's own MCP servers are written into Windlass's configuration file in the sandbox
  for a turn and removed when the turn ends; a server that dies in between leaves them there. The
  session's next turn takes them out before it writes its own, by the platform's list of what it wrote.
  Nothing reads the file in between: no Windlass runs between turns.
- **A user's own MCP server runs unasked, with the network and the session's access token.** Windlass
  asks before it starts a project's server and not before one of its user's own configuration, and
  such a server is a process outside Windlass's sandbox around commands in every profile. The settings
  page says so before one is saved; nothing asks again in a session. On Docker, Windlass's data is
  the user's volume, with the records of the user's other sessions in it.
- **An account's secret reaches no MCP server where commands are not sandboxed.** In `docker-hardened`,
  `e2b-open` and E2B before its check, a server of the user's own that reads a secret does not start
  ("Account settings"), for the reason a repository's secret for MCP servers is not handed over there.
  A value written into the definition itself would reach it, and is then stored and shown as written.
- **A server's definition is checked against a copy of Windlass's rules.** The keys Windlass takes
  for one server are repeated in `server/src/personal-servers.ts`. With a Windlass that takes a key
  the copy lacks, that key cannot be saved; with one that refuses a key the copy has, a saved
  definition would fail its user's turns until it is changed. A sandbox keeps the Windlass of the
  image it was made from, so the second can happen for a sandbox older than the key.
- **Personal servers have not run on E2B.** They were run with a real Windlass in local Docker
  containers, in both profiles; the E2B layer writes the same file through the same seam.
- **A subagent cannot ask to publish.** The platform acts on the calls of the session's own agent, as the
  engine reports them for the session. A subagent's calls are reported another way and are not acted on, so
  one that called the tool would wait until the tool's time is up and be told that the platform did not
  answer. This has not been tried.
- **An MCP server's secret cannot be kept from commands that are not sandboxed.** Where commands run
  without Windlass's sandbox (`docker-hardened`, `e2b-open`), and where it is not established that they
  are sandboxed (E2B before its check), a secret for "setup and MCP servers" is not handed to Windlass, so
  the repository's MCP servers go without it ("A repository's secrets"). Windlass would not give a command
  the variable there, but a command of the same user reads it from Windlass's process. What would close
  it: MCP servers started with an environment that is not Windlass's own, or as another user.
- **A sandbox keeps the Windlass it was made with.** A session whose sandbox was made from an older image
  has what that Windlass has: with 0.2.0, checks of its user's that a repository's own file can replace;
  with one before it, also a read-only home for its sandboxed commands and the narrower secret scopes,
  until its sandbox is replaced: removed for not being used, or lost. Nothing in the platform replaces a
  sandbox for its Windlass. And no sandbox can go back: an image rolled back to 0.2.0 does not open the
  sessions 0.3.0 recorded check results in ("A repository's checks").
- **The launch form's list of secrets is said for the image the platform is built for.** A server does not
  look at the Windlass of its image or template for it (on E2B that would mean starting a sandbox), so
  with an older Windlass there the launch form's sentences are the newer one's, and a session's own list
  corrects them from its first turn.
- **A server that Windlass starts from its own record says nothing of secrets.** When a variable such a
  server reads is not set, no question is put, so the sentence about what would set it is not said: the
  panel lists the server as one that could not start, with Windlass's reason, which names the variable.
- **A project's hooks and language servers are not asked about.** Windlass holds those back as it holds back
  a project's MCP servers, and reports them the same way (`_windlass/hooks`, `_windlass/lsp`). The platform
  puts only the servers' question, so a project's hooks do not run and its language servers do not start.
- **An approval of a project's server is for its definition, not for its files.** Windlass asks again when
  the command, its arguments or its environment change, and not when the script that command runs does: that
  is Windlass's own rule. With the platform's record it reaches further than one sandbox: after a commit that
  changes the script and not the definition, the server starts without a question in every session of that
  user on that repository, new ones included, until the approval is forgotten or 30 days old. The question
  says so where the user approves. And on Docker Windlass's own record holds in all of a user's sessions
  ("A project's MCP servers"): another repository that defines a server of the same name the same way starts
  it unasked there.
- **Forgetting an approval does not reach where the server already started.** Windlass keeps its own record
  in each sandbox the server started in, for 30 days from that start, and has no way to take one back or to
  stop a server. So forgetting holds for the next session and the next sandbox; a sandbox that already
  started the server goes on starting it, and for that reason may do so past the day the panel names. On
  Docker that record is shared by all of a user's sessions, and forgetting changes nothing until it has run
  out. Removing a session's sandbox is what ends it sooner.
- **An approval given in the panel starts nothing by itself.** No Windlass runs between turns, so the server
  starts with the session's next turn. "Not now" is asked again with every message that starts a turn, and a
  message sent while that question holds the turn is refused as "still starting".
- **The panel lists what the session last heard.** A server's state is what Windlass said in the session's
  last turn, not a reading of the sandbox now, and a definition that changed in the repository since is
  seen when the next turn starts. A server Windlass started from its own record is listed without the
  fingerprint of its definition, so the approval shown for it is the newest one of its name.
