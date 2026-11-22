# Validate Codex device login on a machine

API-key login is available from the machine terminal. ChatGPT device login requires an owner-run validation with the pinned adapter and CLI. Use a dedicated machine pairing that offers Codex. The Machines setup command uses `--log-driver none` for the interactive Codex container. Include that option when constructing a one-off setup command yourself. Keep the terminal and verification code private.

1. In the runner's terminal environment, run `WLP_CODEX_DEVICE_LOGIN=1 WLP_CODEX_VERIFY_REFRESH=1 windlass-runner login codex`. For a containerized runner, pass both variables with `docker exec -it -e WLP_CODEX_DEVICE_LOGIN=1 -e WLP_CODEX_VERIFY_REFRESH=1 <runner> windlass-runner login codex`.
2. Choose ChatGPT. Enter the displayed code at the official OpenAI verification URL. Workspace policy may require an administrator to enable device login.
3. Confirm that Machines reports a signed-in Codex harness. Start a session and complete a short turn. Send a second prompt and confirm that it completes. With the validation flag, the relay treats the access token as expiring on the next request after the first Responses request. It saves the rotated token and clears the validation flag. Inventory requests can trigger the refresh between turns.
4. Run `windlass-runner logout codex` in the same runner environment. Confirm that Machines reports signed out and another prompt asks for terminal sign-in.
5. Record the runner and image digests and the outcomes of both turns and logout. A maintainer can then enable device login for the validated pair. Keep verification codes, credentials and account identifiers out of the record.

The login volume belongs to a single machine pairing. Each session receives a signed lease for its local relay. What each mode allows depends on the sandbox profile:

- **Hardened Docker profile: Container access only.** Commands run as `agent` directly in the session's container, under the machine's egress setting, and Codex asks for nothing. The container is the boundary.
- **Windlass sandbox profile: Read-only and Workspace access (the default).** The runner probes the pinned Codex binary first. In both modes every command runs in Codex's own sandbox without network. Read-only cannot change any file. Workspace access can change files in the workspace except `.git`, `.agents`, `.codex` and `.aws`, and in the temporary directories. Codex asks before anything beyond that: a command outside its sandbox (`require_escalated`), an edit outside the writable paths, or more permissions. On this profile every such request is refused, even one the user would allow. The image's `PermissionRequest` hook (`/etc/codex/config.toml`) refuses it inside Codex, so the model learns it was refused and the turn continues. `/etc/codex/requirements.toml` keeps hooks enabled, and a repository's `.codex/` is not loaded (see below). The platform refuses any request that still reaches it and adds a note to the timeline: "Codex asked to run a command outside its sandbox; refused on this profile." for a command, or "Codex asked to edit files outside its sandbox; refused on this profile." for an edit outside the writable paths.
- **Not offered on the Windlass sandbox profile:** Container access and Auto review. That profile's container runs with AppArmor and system paths unconfined, and with user namespaces and mount allowed, so that a command sandbox can run inside it. A command outside such a sandbox would run in that looser container. Auto review would let Codex's reviewer model approve such a command, and `requirements.toml` makes a turn that asks for it fail. The runner starts each Codex container with the profile's mode (`INITIAL_AGENT_MODE`); without it the image opens a session in Read-only. The platform takes a mode only once Codex reports it. If the agent reports a mode the profile does not allow, the platform stops the turn and the agent process and shows an error.

The **Plan first** control selects the collaboration mode independently.

## A repository's `.codex/`

codex-acp 2.9.0 marks the session's workspace as a trusted project. Codex 0.171 loads a trusted project's `.codex/`: `config.toml`, `hooks.json` and `rules/*.rules`. MCP servers, hooks and commands allowed by a rule run outside Codex's sandbox. A cloned repository's contents are untrusted, so the image's `wlp-codex-app-server` (between codex-acp and `codex app-server`) removes that trust setting. The workspace has no trust decision, and Codex ignores its `.codex/`. It also refuses codex-acp's writes to Codex's own config, the only way to trust a hook.

This is the same on both sandbox profiles. On the hardened Docker profile the container is the boundary, and a repository's settings could do no more than the agent's commands in Container access. They are still ignored there: the image is the same, the platform chooses the model and the modes itself, and an MCP server or hook from a repository would start without anyone asking for it.

A `.codex/` written during a session stays unloaded as long as nothing trusts the workspace, and only Codex's user config could (see [Codex's own config](#codexs-own-config-codex_home)). On the Windlass sandbox profile Codex cannot write `/workspace/.codex` (the edit asks for approval, which is refused). A repository's setup command and Container access commands can, and Codex reads config afresh for each session and still ignores it.

A repository's `.codex/` cannot:

- start an MCP server (`mcp_servers`). `requirements.toml` also sets an empty MCP allowlist, so Codex starts no MCP server from any config, including one a skill names;
- run a hook (`[hooks]` in `config.toml`, or `hooks.json`). `requirements.toml` also lets only managed hooks run, which here means the image's own;
- run a command outside the sandbox with an exec policy rule (`decision = "allow"` in `rules/*.rules`);
- widen the sandbox with `sandbox_mode`, `approval_policy`, `approvals_reviewer`, `sandbox_workspace_write` (`writable_roots`, `network_access`), `default_permissions` or `[permissions]` profiles;
- set the environment of commands (`shell_environment_policy`);
- send model requests elsewhere or run a command after a turn with `model_provider`, `model_providers`, `openai_base_url`, `chatgpt_base_url`, `notify`, `profile`, `profiles`, `otel` or the `experimental_realtime_*` base URLs. Codex 0.171 drops these from every project config anyway;
- set any other key: features, agent roles, `experimental_*` settings, instruction files and the rest.

Codex still reads the repository's `AGENTS.md` and its skills (`.agents/skills`, `.codex/skills`). They are instructions to the model, and whatever they ask for runs in the same sandbox under the same refusals.

## Codex's own config (`CODEX_HOME`)

Besides a project's `.codex/`, Codex 0.171 loads a user layer from `CODEX_HOME` every turn: `config.toml`, `rules/*.rules`, `hooks.json`, `AGENTS.md` and `.env`. A user `config.toml` can trust the workspace (`[projects."/workspace"] trust_level = "trusted"`), which loads its `.codex/` after all. It can also set `notify`, which runs outside the sandbox after each turn, or `otel` exporters, which send the session's events elsewhere. A rule with `decision = "allow"` runs a command outside the sandbox, and `.env` sets the environment of Codex and of every command.

A repository's setup command runs as `agent` outside Codex's sandbox, before the session's turns. Container access commands on the hardened profile run as `agent` too. Neither can write that layer. `CODEX_HOME` is `/opt/wlp-codex/home`, a directory owned by root and outside `/home/agent`, where `agent` could rename a directory away and make its own. Only what Codex writes belongs to `agent`:

- `sqlite/` (`CODEX_SQLITE_HOME`): Codex's state, logs, goals, queue, memories and thread history databases;
- `sessions/` and `archived_sessions/`: the rollout of each thread;
- `skills/`: the skills bundled with Codex, unpacked into `skills/.system` at start;
- `tmp/`, `.tmp/` and `thread-writer-locks/`: temporary files, the helper links Codex puts first on `PATH`, plugin staging and locks;
- `shell_snapshots/`, `log/` and `cache/`: created in advance, unused with this configuration;
- `installation_id` and `.sandbox_migration`: two files Codex opens for writing. The installation ID is the same for every session of the image.

Skills written to `skills/` are instructions to the model, like a repository's. `wlp-codex-app-server` refuses to start Codex if `CODEX_HOME` is writable by its user, or holds any of the user layer's files. It also sets `CODEX_HOME` and `CODEX_SQLITE_HOME` itself.

Codex's shell snapshot would run the agent's login shell outside its sandbox at each session start, and with it `~/.bash_profile` or `~/.profile`. `requirements.toml` turns it off. A repository's setup command can still write the agent's shell startup files, since `/home/agent` belongs to `agent`. Codex runs each command as a login shell inside its sandbox, so they run there, with the command's own limits: no network, and writes only to the workspace and the temporary directories in Workspace access. In Container access they run like any command in the container.

`scripts/codex-sandbox-escape-check.mjs` checks each of these against a local image, including a user config that a setup command tries to leave (written with `docker exec -u agent`).

In `restricted` egress mode the machine's proxy refuses requests from Codex sessions to `api.openai.com`, `auth.openai.com` and `chatgpt.com`. It blocks OpenAI only by hostname. This is a policy, not a security boundary: a command can still reach OpenAI by another route, and it can always make model requests through its session's relay. Credentials are safe regardless, because a session holds only a signed lease for its relay and never the machine's login.
