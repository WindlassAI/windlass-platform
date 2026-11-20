ARG SANDBOX_IMAGE=windlass-platform-sandbox:latest
FROM ${SANDBOX_IMAGE}
USER root

# package-lock.json pins the npm archives, including Anthropic's unmodified Claude Code CLI.
# claude-agent-acp 0.109.0: SHA-1 b162c045f6d58a259bbfaadef5ad65f963c3c56c
#   sha512-6JkcDZg4Zx2FbTcQaUHUCGUwyvqJRM4oIw1+zA1xjOO+uB50BOZS3iNLK3wWZ6UKFrY7L31zqryqHM2DB+wU6Q==
# claude-agent-sdk 0.3.328 (Claude Code 2.1.328):
#   sha512-YcOWlpXVm7etPjPVrvSJEfynDksMiG11zvEybSBnk1EVWji6rSjU75HbbhJ8XPEB2ECEwRRP597Udu6IWMtsDw==
# claude-agent-sdk-linux-arm64 0.3.328:
#   sha512-VvsUzOEf7r3ZtOPfliNGxqknsIvxEmnUOtQnq4+uw7MsfiALKR4s0bx2SP32UuXpqbmqxR1gn456D27XgsAmnA==
# claude-agent-sdk-linux-x64 0.3.328:
#   sha512-saP4fWgVZj1n7MYCqvTKADHXIc/hIAMRDpLVpXD5xB0IT68vhWgIMkzIrsg5P02P6zA49TDuoijbP1YBUEXT4A==
COPY package.json package-lock.json /opt/wlp-claude/
RUN cd /opt/wlp-claude \
 && npm ci --omit=dev --ignore-scripts --no-fund --no-audit --cache=/tmp/wlp-claude-npm \
 && rm -rf /tmp/wlp-claude-npm
COPY --chmod=0644 managed-settings.json /etc/claude-code/managed-settings.json
COPY --chmod=0755 wlp-claude-acp /usr/local/bin/wlp-claude-acp
RUN chmod 0755 /etc/claude-code \
 && mkdir -p /run/wlp-harness/claude && chown agent:agent /run/wlp-harness
USER agent
# SHA-256 from https://downloads.claude.ai/claude-code-releases/2.1.328/manifest.json
# These also match package/claude in the corresponding npm archives.
RUN --network=none set -eu; \
    test -r /etc/claude-code/managed-settings.json; \
    arch=$(node -p 'process.arch'); \
    case "$arch" in \
      arm64) sha=307f8bada27b37db7553fac75e86004e3dbff5a931ffc611b54fe710ce1eb521 ;; \
      x64) sha=a982d38030b97e750848add2cbb2df6d9a70d5544a22ca9b216a349ba25865e8 ;; \
      *) echo "Unsupported Claude CLI architecture: $arch" >&2; exit 1 ;; \
    esac; \
    printf '%s  %s\n' "$sha" "/opt/wlp-claude/node_modules/@anthropic-ai/claude-agent-sdk-linux-$arch/claude" | sha256sum -c -; \
    test "$(wlp-claude-acp --version)" = '0.109.0' \
 && test "$(wlp-claude-acp --cli --version)" = '2.1.328 (Claude Code)'
LABEL dev.windlass-platform=1 dev.windlass-platform.harness=claude dev.windlass-platform.adapter="claude-agent-acp 0.109.0"
