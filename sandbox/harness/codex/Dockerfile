ARG SANDBOX_IMAGE
FROM ${SANDBOX_IMAGE}
USER root
COPY package.json package-lock.json /opt/wlp-codex/
RUN cd /opt/wlp-codex && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache=/tmp/codex-npm \
 && rm -rf /tmp/codex-npm \
 && ln -s /opt/wlp-codex/node_modules/@openai/codex-linux-*/vendor/*/bin/codex /usr/local/bin/codex
# Codex loads a user layer from CODEX_HOME every turn (config.toml, rules/, hooks.json, AGENTS.md, .env).
# A repository's setup command and Container access commands run as agent, so CODEX_HOME is root's and
# outside /home/agent (agent could rename a directory there). Only what Codex 0.171 writes is agent's:
# its state databases (CODEX_SQLITE_HOME), rollouts, shell snapshots, bundled skills, temporary files
# and locks, and two files it opens for writing: installation_id (the same for every session of this
# image) and a sandbox migration marker.
RUN install -d -m 0755 /opt/wlp-codex/home \
 && for dir in sqlite sessions archived_sessions shell_snapshots skills tmp .tmp thread-writer-locks log cache; do \
      install -d -o agent -g agent -m 0700 "/opt/wlp-codex/home/$dir"; done \
 && printf 00000000-0000-4000-8000-000000000000 > /opt/wlp-codex/home/installation_id \
 && touch /opt/wlp-codex/home/.sandbox_migration \
 && chown agent:agent /opt/wlp-codex/home/installation_id /opt/wlp-codex/home/.sandbox_migration
COPY LICENSE NOTICE /usr/local/share/doc/wlp-codex/
COPY config.toml requirements.toml /etc/codex/
COPY --chmod=0755 wlp-codex-acp wlp-codex-app-server /usr/local/bin/
# The runner names the session's mode (sandbox/sandboxes.ts); without it a session opens in Read-only.
ENV CODEX_HOME=/opt/wlp-codex/home CODEX_SQLITE_HOME=/opt/wlp-codex/home/sqlite \
    CODEX_PATH=/usr/local/bin/wlp-codex-app-server INITIAL_AGENT_MODE=read-only
USER agent
RUN --network=none test "$(codex --version)" = "codex-cli 0.171.0" \
 && test "$(/opt/wlp-codex/node_modules/.bin/codex-acp --version)" = "@agentclientprotocol/codex-acp 2.9.0" \
 && ! test -w /opt/wlp-codex/home
LABEL dev.windlass-platform=1 dev.windlass-platform.harness=codex dev.windlass-platform.adapter="codex-acp 2.9.0"
