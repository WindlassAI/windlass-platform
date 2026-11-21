ARG SANDBOX_IMAGE
FROM ${SANDBOX_IMAGE}
USER root
RUN set -eu; case "$(dpkg --print-architecture)" in \
      arm64) arch=arm64; sha=5b68c1f4c5e75b4134e664cc8f36d634d64208d4fcfe5bcf3b48bab699c2dbac ;; \
      amd64) arch=x64; sha=47734e08968b30cc22a0bffb6d9feeed76ad4aa743213a12122040392d09a057 ;; \
      *) exit 1 ;; esac; \
    curl -fsSL --retry 3 "https://github.com/anomalyco/opencode/releases/download/v1.19.6/opencode-linux-$arch.tar.gz" -o /tmp/opencode.tar.gz; \
    echo "$sha  /tmp/opencode.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode; rm /tmp/opencode.tar.gz
COPY LICENSE /usr/local/share/doc/opencode/LICENSE
COPY config.json /etc/wlp-opencode/opencode/opencode.json
COPY --chmod=0755 wlp-opencode-acp /usr/local/bin/
USER agent
RUN --network=none test "$(opencode --version)" = 1.19.6
LABEL dev.windlass-platform=1 dev.windlass-platform.harness=opencode dev.windlass-platform.adapter="OpenCode 1.19.6"
