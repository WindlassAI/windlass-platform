ARG SANDBOX_IMAGE
FROM ${SANDBOX_IMAGE}
USER root
COPY package.json package-lock.json /opt/wlp-codex/
RUN cd /opt/wlp-codex && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --cache=/tmp/codex-npm \
 && rm -rf /tmp/codex-npm \
 && ln -s /opt/wlp-codex/node_modules/@openai/codex-linux-*/vendor/*/bin/codex /usr/local/bin/codex
RUN install -d -o agent -g agent -m 0700 /home/agent/.codex
COPY LICENSE NOTICE /usr/local/share/doc/wlp-codex/
COPY config.toml requirements.toml /etc/codex/
COPY --chmod=0755 wlp-codex-acp wlp-codex-app-server /usr/local/bin/
ENV CODEX_HOME=/home/agent/.codex CODEX_PATH=/usr/local/bin/codex INITIAL_AGENT_MODE=agent-full-access
USER agent
RUN --network=none test "$(codex --version)" = "codex-cli 0.171.0" \
 && test "$(/opt/wlp-codex/node_modules/.bin/codex-acp --version)" = "@agentclientprotocol/codex-acp 2.9.0"
LABEL dev.windlass-platform=1 dev.windlass-platform.harness=codex dev.windlass-platform.adapter="codex-acp 2.9.0"
