# GitHub and repositories

How the platform works with GitHub, and what it keeps for a repository and for an account: the setup
command, checks, the "What was verified" section of a pull request, secrets, MCP servers, the repository
page and account settings. Registering the GitHub App is in [operating.md](operating.md#the-github-app).
What users see of all this is in the in-app docs ([Settings](../web/src/docs/content/settings.md),
[Sessions](../web/src/docs/content/sessions.md), [Sandboxes and security](../web/src/docs/content/security.md)).

## GitHub

With a GitHub App of its own, a deployment lets a user connect GitHub, launch an agent on one of their own
repositories, private ones included, and get the work back as a pull request. Without one the web app shows
nothing of this, and a repository is a public address pasted into the launch form.

- **Connecting.** "Connect GitHub" (the account menu, or the launch form) sends the browser to GitHub, where the
  user authorizes the app; with the app installed nowhere they can reach, GitHub's installation page follows,
  where they pick an account and its repositories. GitHub sends the browser back to `GET /github/callback` on a
  server's own port, with a code. The server exchanges it, asks GitHub who this is and which installations of
  the app they can reach, deletes the token it was given, and sends the browser on to the web app, which
  hands what GitHub confirmed to the user's `user` actor. The web app does this in a popup window, so the
  page and the launch form's text stay: back at the web app, the popup posts the fragment to its opener with
  `postMessage` at its own origin and closes, and the opener takes it only from that origin, from a window it
  opened, and of that shape (`web/src/state/github.ts`). Where the browser blocks the popup, the page itself
  goes to GitHub and back, keeping the launch form's text in the tab. Either way it is the same state, the
  same callback and the same ticket. That is the connection: a GitHub login and the
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
  platform for the same ([The agent's own tools](#the-agents-own-tools)).
  The pull request's description ends with a section the platform writes, and writes again with every
  push: which checks ran before the agent's turn was called done, whose they are, how each ended, and
  what in the changes is worth a look ([What a pull request shows was verified](#what-a-pull-request-shows-was-verified)).
  A commit is made in the GitHub user's name (`<id>+<login>@users.noreply.github.com`); the pull request is
  the app's.


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
| a work item's handoff: the review request and the verdict's comment | pull requests: write, metadata: read (one repository) | the server |
| posting `windlass/verified` | checks: write, metadata: read (one repository) | the server |
| an orchestrated feature's preflight: does push CI report on its branches | contents, actions, checks, statuses, pull requests: read, metadata: read (one repository) | the server |
| reading an issue filed as a work item | issues: read, metadata: read (one repository) | the server |
| commenting on that issue | issues: write, metadata: read (one repository) | the server |

**In a sandbox** the token is given to the one git command the platform itself runs, and to nothing else
(`server/src/github/git.ts`):

- It is written to the command's standard input. It is in no argument and no environment variable, neither on
  the server (where Docker's would be on a `docker exec` command line) nor in the sandbox.
- The script reads it into a shell variable that is never exported and hands it to git on a pipe. Git is told,
  in its environment's configuration, of a credential helper that answers a request for GitHub's host by
  reading that pipe: the pipe is empty once git has read it, and git sends the token only where GitHub asked
  for it, as [GitHub documents it](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation):
  the HTTP password of the user `x-access-token`.
- Hosted Docker and machine runners use `docker exec --user 65534:65534` for authenticated Git.
  E2B selects the template's `nobody` user. Each operation creates a fresh directory under sticky
  `/tmp` with mode 0700. Git starts there with a platform-created repository and system binaries. The workspace receives a copy of a successful clone or fetch after Git exits.
- The transport clears the environment and disables system and global Git configuration. It pins
  the runner's configured loopback proxy (or an empty proxy), TLS verification and the system CA
  bundle. It disables redirects, SSH, prompts, hooks and recursive submodule pushes. The only
  credential helper answers for the configured HTTP(S) host. Workspace config, config includes,
  URL rewrites, remote push URLs, push options, HTTP headers, alternate object databases, external
  helpers and inherited Git, SSH, proxy and TLS variables have no input into the transport.
- The workspace user stages a candidate commit and exports a pack. The transport user builds a
  fresh index from that pack, verifies the objects and scans the history of the SHA held by the
  session. Immediately before each push it recomputes a SHA-256 digest of the outgoing object IDs
  from the same head and confirmed boundaries. Git receives that head and one explicit refspec.
  After Git exits, the workspace user installs the new objects, branch and index. Packing and
  verifying the candidate history costs time and temporary disk space proportional to the repository.

**What an agent's command can still observe.** A direct command can list process arguments and
temporary directory names. It can change the workspace and the staging files it owns, interrupting
a publish or changing the candidate content before the scan. The transport user's private Git
directory, token pipe and scanned objects are protected by Unix permissions. This boundary depends
on the sandbox keeping the agent unprivileged and its Git executable and system trust store under
platform control. Machine runners must support the transport-user execution option.

### Enable the Factory check on GitHub

1. Open **Settings → Developer settings → GitHub Apps → *your App* → Edit → Permissions & events**.
2. Under **Repository permissions**, change **Checks** from **Read-only** to **Read and write** and click **Save changes**. Keep the existing event subscriptions, including **Check run**.
3. GitHub emails each installation owner. Each installation keeps its current permissions until its owner approves the update.
4. For a personal installation, open **Settings → Applications → Installed GitHub Apps → *your App* → Configure** and accept the request at the top. For an organization installation, open **Organization settings → GitHub Apps → *your App* → Configure** and accept there as well. Repeat for every installation.
5. GitHub sends `installation.new_permissions_accepted`. Windlass logs the delivery and posts on the next verification. Before approval, the item logs one permission message per run and still hands over its verdict, comment and review request.
6. Optionally require `windlass/verified` in a repository's branch protection rule or ruleset and select your App as its source. Enable auto-merge separately if desired.

[GitHub's installation permission approval guide](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app)

### The agent's own tools

A user who tells the agent to "open a pull request", or whose long task ends while they are away, wants the
agent to be able to get its work out. The agent still has no GitHub credential: it asks the platform, and the
platform does the git and GitHub work with the code and the tokens of the panel's own buttons
(`server/src/github/publish.ts`), each token for one step and revoked after it.

- **Four tools** (`server/src/agent-publish.ts`, `platformTools`), in a session on a repository of the GitHub
  connection, on a deployment with a GitHub App:
  - `publish`: commit what is uncommitted, push the session's branch, and open the session's pull request, or,
    when it is open, push to it and give it the call's title and description. A person's session only. It
    writes three things: the pull request's title and description, and the commit's message (the title, when
    it gives none). A request that names a branch other than the session's, or a base other than the branch
    the session started from, is refused, and so is whatever a push from the panel is refused for.
  - `push`: commit what is uncommitted with the agent's message and push the session's branch, as often as the
    agent likes. It opens no pull request.
  - `fetch_base`: fetch the branch the session started from into the workspace as `origin/<base>`, and the
    session's own branch as GitHub has it as `origin/<branch>`, with a token that may only read, so that the
    agent can rebase onto the base or merge it, merge what someone else pushed to its branch, and push again.
  - `report`: a work item's agent files what it did, in place of `publish` ([Work items](work-items.md)).
  A session without such a repository is offered none of them.
- **How the agent calls them.** They are Windlass's *host tools* (its docs/acp.md, "Tools the client runs"):
  the platform declares them each time it opens or resumes the Windlass session (`_meta.windlass.hostTools`,
  `server/src/sandbox/turn.ts`), the model finds them beside Windlass's own, and a call reaches the platform
  as a request on the engine's connection (`_windlass/host_call`), answered for that turn's session while the
  turn runs. The platform's answer is the call's result: what was pushed or published and the pull request's
  address, or why nothing was, in the platform's own words with GitHub's refusal or the user's note quoted in
  them. Nothing of the tools is in the sandbox: no file, no process, no server.
- **Who is asked.** Each tool is declared `read`, which Windlass never asks about; what needs the user is asked
  by the platform:
  - `push` and `fetch_base` are never asked about, in any profile, whatever "Let the agent publish without
    asking" says. A push goes only to the session's own branch, which the platform names: a call that names
    another branch is refused, so the repository's default branch is out of reach. A push is a plain push
    first, so a fast-forward goes whoever pushed before it. Only one GitHub refuses as no fast-forward (the
    agent rebased) is tried again under a lease on the commit the platform itself last pushed there
    (`--force-with-lease`, `pushScript` in `server/src/github/git.ts`; the session keeps that commit apart
    from what a new sandbox's clone found, which may be someone else's): it replaces the platform's own push
    and nothing else. A commit anyone else pushed since is never pushed away; the push is refused with a
    sentence that says to fetch and merge it. A work item's publish step pushes the same way; the panel's
    push never forces.
  - Before sending work, the platform reads the message and patch of every outgoing commit as text,
    including merge commits and binary files. The session keeps its base commit in platform state.
    GitHub confirms that commit independently of the sandbox. Only that base and the observed work
    branch head can exclude history from the scan. The platform refuses a push when it finds a saved
    secret value, a recognized credential shape, or 8 MB of history to check. For credential shapes,
    the scan examines added lines, commit messages and paths. The refusal names the credential
    kind and includes a safe file path when available. The saved-value check still covers the full
    patch. A missing base requires `fetch_base` before publication. Encoded values can escape detection.
    When it refuses the push, changes from the platform's own commit stay in the workspace.
  - Concurrent changes to the workspace's `.git` during `push` or `fetch_base` can no longer make
    platform Git run a workspace-defined program. Status, diff, probe, commit, history scan, fetch
    and push use an explicit private Git directory. The platform copies the agent's objects, refs
    and index as data to preserve its commits, merges and rebases. It captures tracked and unignored
    files using directory-relative reads that refuse to traverse symlinks. A symlink contributes its
    target text. Git loads only platform configuration, with hooks and filesystem monitors disabled.
    A work-tree `.gitattributes` can name a filter, but the private repository defines no such driver.
    Windlass gives sandboxed commands a different `/tmp`. Direct commands share the staging user's
    temporary directory. Authenticated Git and the outgoing scan use the separate transport uid.
  - The guard still refuses a redirected Git directory, program or transport settings in the
    workspace configuration, gitlinks, nested repositories and incomplete scans. Git-ignored
    `node_modules` directories are skipped. Repositories using Git LFS cannot be pushed yet.
    After a successful push or fetch, the platform installs objects and updates refs with file
    operations. It checks the original repository, refs and index under Git's locks before
    advancing them. If another command changed them, the agent keeps its local state and receives
    the remote push result so it can fetch and reconcile the branch.
  - `publish` is put to the user unless the session lets the agent publish without asking (below).
  - A push or a fetch may take five minutes; a publish may wait for the user's answer first, and is declared
    with that time added, at most an hour. One at a time: a push or publish asked for while another is being
    handled is refused with that sentence, and so is a call after its turn has ended.
- **What a push sets off at GitHub.** A push to the session's branch is the GitHub App's push, and GitHub
  starts the repository's workflows that run on a push to such a branch, as after a push from the panel. A
  workflow that runs the repository's own code (its tests, its build, its install scripts) then runs the
  agent's code, with whatever Actions secrets that workflow is given, and the agent's push is asked about
  by nobody. The workflow files themselves are the branch's, and the app may not change them
  (`.github/workflows`: such a push is refused). An agent that pushes often makes CI run often.
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
- **What the user sees afterwards.** One line in the timeline for each call. For a publish, as after a push from
  the panel, beginning with who allowed it: "The agent asked to publish, and you allowed it once. Opened pull
  request #12 …", or "…, and you did not allow it: …", or why it did not go through. For a push: "The agent
  pushed its work to windlass/fix-the-light-3f9a2c (1a2b3c4). Pull request #12 shows it; its description
  reports: 2 checks passed.", or "The agent asked to push, and it did not go through: GitHub refused the push:
  a rule of acme/quay protects branches named like windlass/…. …". For a fetch: "Fetched main from GitHub into
  the workspace as origin/main, as the agent asked." An open pull request's verified section is written again
  after a push, saying the turn's checks have not run on it yet, and once more when the turn has ended. With
  no pull request open, the panel's "Open pull request" opens one from what the agent pushed.

What a command the agent runs can do about any of this depends on where it runs:

| Profile | A command the agent runs | Without asking |
|---|---|---|
| commands sandboxed by Windlass (`docker-windlass-sandbox`, E2B with its sandbox promised) | cannot write on the engine's connection to the platform: every call is the model's | `push` and `fetch_base` always; `publish` once the user allows it |
| commands not sandboxed (`docker-hardened`, `e2b-open`), or nothing promised (E2B before its check) | runs as Windlass's user and can write on the engine's own connection (its standard output, through `/proc`), so it can make a call in the agent's name | `push` and `fetch_base` always, since a forged one pushes the workspace, which the command can change anyway, to the session's own branch; `publish` never: every request is put to the user, the question says a command could have asked it, and it offers no "Allow for this session" |

So where commands are not sandboxed a command can push the session's branch and raise the question, and
cannot open a pull request by itself. That is the same line as with a repository's secrets: where a promise
does not hold by construction, the platform does not rely on it. The second row is by reading of how the
engine's connection works: a forged host call has not been tried.

**A sandbox from before the tools.** The tools need a Windlass that lists `hostTools` among the keys it takes
(0.4.0 does). Every sandbox the platform makes has one. A turn in a sandbox whose Windlass does not take them
fails with "This agent's sandbox is from an older version of the platform, whose Windlass cannot give the
agent the platform's tools, so nothing was run. Start a new agent." (on a person's machine: install the
current runner there, then start a new agent), a work item's too (its person is asked, with that sentence).

### When a sandbox is replaced

A sandbox made in place of a lost one has a fresh workspace. It is cloned at the branch the session started
from, and the repository's setup command runs there ([A repository's setup command](#a-repositorys-setup-command)). Only then, where the
session's work was pushed, is the workspace put on the session's branch as GitHub has it now: what was pushed
is back, with anything pushed to that branch since, and what was only in the old sandbox is not. Where a setup
command ran, the timeline says "Put the workspace on windlass/fix-the-light-3f9a2c at 1a2b3c4. The setup command
ran on main before that, so what the branch changed in its dependencies is not installed.", and the agent is
told the same with its next prompt. The setup command never runs on what a session pushed: that is the agent's
work, and the command runs with the network and every secret saved for the repository. If GitHub no longer has
the branch (deleted after a merge, say), the workspace stays on the base branch and the timeline says so. The
agent is told with its next prompt that the workspace is a fresh one.

A subtask runs setup at the commit where its feature started, including when its sandbox is replaced.
After setup, the workspace switches to the integrated feature branch or the subtask’s own published work.

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

### Testing without GitHub

No check calls GitHub. `scripts/github-standin.ts` stands in for it: its API and token endpoints, its
authorization and installation pages, and a git remote over HTTP in front of real bare repositories, with
GitHub's refusals written from what is known of them and not copied from a run against it.

```sh
cd server && npx tsx ../scripts/github-check.ts             # the server's GitHub code and real git against the stand-in
cd server && npx tsx ../scripts/github-check.ts --docker  # and the git commands again in a container of the sandbox image
cd server && pnpm e2e                                       # its last section: the route and the actors, on the fake layer
```

`github-check.ts` has the rules of a request of the agent's as well ([The agent's own tools](#the-agents-own-tools)): what it
may hold, the tools' declarations, what `publishWork` does with an open pull request for the agent and for
the panel, and the agent's push (its own branch only, under the lease, a rebase, a commit someone else
pushed). `mcp-check.ts --report` calls the tools through a real Windlass; the fake sandbox layer's model calls
`push`, `fetch_base` and `report` when the prompt says "(push)", "(fetch)" or "(report)", so the end-to-end
test pushes through the actors.

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
  (`package.json` scripts, a `setup.sh`, `.windlass/`) is looked at for it, and it runs only on the branch the
  session was launched from. A session on a pasted address or
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
  sandbox made in place of a lost one is cloned into again at the branch the session started from, set up
  there, and only then put on the session's branch ([When a sandbox is replaced](#when-a-sandbox-is-replaced)). The setup command never runs
  on what a session pushed: that is the agent's work, and the command runs with the network and the
  repository's secrets. What the branch changed in its dependencies is not installed by it; the agent is told,
  and installs them with its own commands (without the secrets that are for setup alone). A command that cannot
  be read from the user's actor when it is due refuses the turn, and nothing is started: the agent never works
  in a sandbox whose setup is still to run.
- **What the user sees.** The run is in the session's timeline, where the clone's line is: the command, what
  it prints as it arrives, how it ended and how long it took. It is one item when it starts and one when it
  has ended (`kind: "setup"`), with `setup.output` deltas in between on the feed the model's streaming text
  uses; the ending item keeps the last 32,000 characters. The session's Stop stops it, and the turn with it.
- **If it does not succeed** (another exit code than 0, the time limit, a stop, a server that stopped under
  it), the session goes on: the turn is not failed for it. The agent is told once, before the next prompt
  Windlass takes, as it is told of a fresh workspace: the platform's note, the command, how it ended, and
  the last twenty lines of what it printed. The timeline keeps the prompt as the user wrote it.
- **No credential of the platform's is handed to it.** What it is handed is what the user saved for the
  repository as secrets ([A repository's secrets](#a-repositorys-secrets)). The token a clone used was given to that one `git clone` on its
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
- **Required checks are named when the session opens.** A session reads the checks from the user's
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
  file in the sandbox has it. Windlass records `session` as the origin of a check the platform named.
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
- **Where commands are not sandboxed.** In `docker-hardened` Windlass runs checks as it runs the agent's
  commands there, without its sandbox. A command of the agent's can write Windlass's own configuration
  file there. The next turn removes those settings before Windlass reads the file. A command there can still reach Windlass's
  process itself, as it can the engine's connection to the platform ("What it cannot say" below).

```sh
cd server && npx tsx ../scripts/verified-check.ts                                   # the rules on their own: what may be saved, the configuration file, a turn's events, the section
cd server && npx tsx ../scripts/verified-check.ts --docker                       # run the same rules against the image’s Windlass
```

The web app's mock has two checks saved for acme/harbor (`?mock=1`, `/repositories/7101/settings`), one of them with
file patterns that the mock's turns never match. A mock turn on a repository whose checks all have patterns ends with no
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
  that turn the agent was sent back with it failing. The section identifies the user's required checks, names saved checks whose patterns did not match, and describes how the repository configured its own checks. The end of a check's output is
  folded, for one that did not pass and for one whose user asked (1,500 characters, of six checks at
  most). And when nothing was verified, one plain sentence: "Nothing was verified: no checks are
  set for this repository.", or which file turned verification off, or that the turn was stopped before
  its checks had run. There is no badge and no tick in it, and it ends by saying that it is not a review.
- **What a turn that needed no check rests on, and a check that was not started.** Windlass records the reason, the workspace state, and any start error.
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
  exit code, duration and retained output); a message the harness appends with the origin
  `check_report`, followed by a model call (`step.started`), is the agent being sent back (Windlass
  writes the same message with an ending that leaves checks unresolved, for whoever continues the
  session, and that one sends nobody back); `execution.succeeded` has how the gate ended, why a turn
  was let end with a check failing, and why no check was needed and on what;
  `snapshot.taken` names each state of the workspace. A key of the evidence or of an ending that the
  platform does not know is passed over, and an ending is never compared whole. The session's
  actor keeps what they come to (`Verified`) on the item that ends the turn, and in its own state for the
  next push. A turn in which no check ran keeps what the last run found, with the turn it was in.
  The evidence names the check's `origin` and `required` status and carries its redacted `outputTail`.
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
  credential by the GitHub layer's own (`server/src/github/redact.ts`). Windlass redacts credentials before recording a check’s output. The platform also removes saved
  secret values from each incoming event.
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
  Where commands are not
  sandboxed, a command can write on the engine's connection to the platform ("The agent's own
  tools"), so an agent that set out to could forge the events themselves; in the profiles where
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
  open). [Sign-ins](architecture.md#sign-ins) says what that encryption protects against and what not; the same holds here. A session
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
- **Credential names.** `looksLikeCredential` mirrors Windlass's filter so `passEnv` includes credential-like names that the agent’s commands may use. `scripts/secrets-check.ts` compares the filter against Windlass's source when available.
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
like a credential and under one that does not. The mock stores only their names and scopes.


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
  ([A repository's secrets](#a-repositorys-secrets)). The question says which saved secrets approving hands over ("Its definition
  reads the secret HARBOR_TOKEN saved for this repository: approving gives its value to the server.", or
  "... sends its value to that address."). For a variable that is not set it says what would set it ("It
  will not start yet: its definition reads the variable HARBOR_TOKEN, which is not set where Windlass runs.
  Save a secret named HARBOR_TOKEN for acme/harbor, under Secrets in this session's panel: it is handed over
  from the next turn."), or, where a secret of that name is saved and the session's sandbox keeps it from MCP
  servers (commands are not held in Windlass's sandbox there), why. An
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
  too, apart from the project's, with a state and no approval ([Account settings](#account-settings)).
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
  answered by the platform, where its user said so ([Account settings](#account-settings)).

```sh
cd server && npx tsx ../scripts/mcp-check.ts                         # a real Windlass in local containers, and fixtures/mcp-repo
cd server && pnpm e2e                                                   # the session's part, on the fake layer's "(mcp...)" switches
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
  work items ([Work items](work-items.md)), and the pull requests the sessions opened that are still open, as each
  session's summary last had them (GitHub is not asked for a list, so one merged or closed at GitHub stays
  until its session's panel next reads it), each with what its description says was verified, in a few
  words. **Settings** (`/repositories/<id>/settings`, `web/src/screens/RepositorySettings.tsx`) has the
  defaults for new sessions; the setup command and the secrets, in the same components a session's panel
  has (`SetupEditor`, `SecretsBlock`); the checks ([A repository's checks](#a-repositorys-checks); `ChecksEditor`); the remembered
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
  the sandbox against what the deployment offers and the model against the user's own models ([Models](architecture.md#models)),
  and do nothing on the server afterwards: the launch form reads them
  when that repository is picked, starts from them, and says so beside the repository, since the sandbox is
  chosen further up. A choice made in the form comes first and holds for that session only. A default that
  names a sandbox the deployment no longer offers, or a model that is not in the user's list, is left out,
  and both the page and the form say so: of a list that only stands in for the plan's, that the model is
  left out for now. Whether the agent may publish without asking is the session's own setting and is not among them.
  Where a repository saves none, the account's default holds ([Account settings](#account-settings)), and the page says so
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
`saveAccountDefaults`, `forgetLastStart`, `savePersonalServer`, `deletePersonalServer`, `accountSecrets`,
`saveAccountSecret`, `deleteAccountSecret`). Where the deployment offers work items, the same page has the
user's API tokens, with which a script files them ([Work items](work-items.md)).

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
- **Where the last agent started.** Not a saved default: the place, the agent and the mode of the newest
  agent the user started, which the server writes in a row of its own when it makes that agent
  (`AccountSettings.lastStart`; a work item's agents never do). The launch form starts those three
  from it, and from nothing else (`startedOn`), so forgetting it is what it says; a machine that
  cannot be used, or an agent it no longer offers, leaves it hosted with Windlass, and the form says
  so. `forgetLastStart` removes it.

### MCP servers of the user's own

A user defines MCP servers once, and every session of theirs has them: an issue tracker, a
documentation search, whatever the repository. They are never read from a repository; a repository's
own servers are the ones in its `.windlass/config.json` ([A project's MCP servers](#a-projects-mcp-servers)).

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

A server needs a token. The account's secrets are a repository's secrets ([A repository's secrets](#a-repositorys-secrets))
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
  and a server that reads it starts. Account settings show each secret’s reach for the chosen profile, and a
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
cd server && pnpm e2e                                                   # one step of its last section: through the actors, on the fake layer
cd server && npx tsx ../scripts/mcp-check.ts                          # its section on a user's own server: a real Windlass asks about a tool, and is answered where the setting is on
```

The web app's mock has two servers and two secrets saved for the account (`?mock=1`; `&account=empty`
for an account with nothing saved): one server that runs and whose tools run without asking, one
whose secret is not saved, a secret that is also for the agent's commands, and one under a name
acme/harbor has one of its own for. Its seeded sessions that have a sandbox list them.

