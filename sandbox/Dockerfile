# The sandbox image of windlass-platform: one container per agent session.
# Built by sandbox/build.sh, which puts the Windlass binary into the build context as ./windlass.
FROM ubuntu:24.04 AS base

ARG DEBIAN_FRONTEND=noninteractive

# What Windlass needs (bubblewrap for its command sandbox, GNU env from coreutils, git for undo
# snapshots) and what an agent needs to build and test a project: a compiler and make for packages
# that build native code, and Python with pip and venv. procps gives the platform `pkill -s` to stop
# everything a turn started.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap git ripgrep coreutils ca-certificates curl procps \
      build-essential pkg-config jq unzip zip xz-utils \
      python3 python-is-python3 python3-pip python3-venv python3-dev \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* \
 && if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi

# Node, bun, uv and pnpm from their own releases, each at a version named here: Ubuntu's packages are
# years behind what current projects ask for, and a version should change when this file does. Every
# download is checked against the checksum its release publishes.
ARG NODE_VERSION=24.22.3
ARG BUN_VERSION=1.4.4
ARG UV_VERSION=0.13.8
ARG PNPM_VERSION=12.21.0
RUN set -eu; cd /tmp; \
    case "$(dpkg --print-architecture)" in \
      amd64) node=x64; bun=x64; uv=x86_64 ;; \
      arm64) node=arm64; bun=aarch64; uv=aarch64 ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    f="node-v${NODE_VERSION}-linux-${node}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${f}"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${f}\$" | sha256sum -c -; \
    tar -xJf "${f}" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE; \
    f="bun-linux-${bun}.zip"; \
    curl -fsSLO "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${f}"; \
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt" | grep " ${f}\$" | sha256sum -c -; \
    unzip -q "${f}"; install -m 0755 "bun-linux-${bun}/bun" /usr/local/bin/bun; ln -s bun /usr/local/bin/bunx; \
    f="uv-${uv}-unknown-linux-gnu.tar.gz"; \
    curl -fsSLO "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${f}"; \
    curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${f}.sha256" | sha256sum -c -; \
    tar -xzf "${f}"; install -m 0755 "uv-${uv}-unknown-linux-gnu/uv" "uv-${uv}-unknown-linux-gnu/uvx" /usr/local/bin/; \
    npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}"; \
    rm -rf /tmp/* /root/.npm; \
    node --version; npm --version; pnpm --version; bun --version; uv --version; \
    mv /usr/local/bin/pnpm /usr/local/bin/pnpm-image

# A non-root user. The data directory exists in the image owned by `agent`, so an empty named volume
# mounted there takes that ownership.
#
# Windlass's command sandbox lets a command write in the workspace and in /tmp, and under the home
# directory only what is not there yet (a home of the session's own).
# The package managers keep their caches in the home directory: in a read-only one npm and uv fail, pip
# goes without a cache and pnpm puts its store into the project, and a cache that a command outside the
# sandbox made there (the repository's setup command) is read-only for the sandboxed ones. So each is
# told, in its own configuration file, to keep its cache under /tmp/.cache, which a command can write
# with the sandbox and without it.
RUN useradd --create-home --uid 1000 --shell /bin/bash agent \
 && install -d -o agent -g agent /tmp/.cache \
 && mkdir -p /workspace /home/agent/.local/share/windlass /home/agent/.config/pnpm /etc/uv /usr/local/etc \
 && chmod 700 /home/agent/.local/share/windlass \
 && printf 'cache=/tmp/.cache/npm\nupdate-notifier=false\n' > /usr/local/etc/npmrc \
 && printf '[global]\ncache-dir = /tmp/.cache/pip\n' > /etc/pip.conf \
 && printf 'cache-dir = "/tmp/.cache/uv"\n' > /etc/uv/uv.toml \
 && printf '[install.cache]\ndir = "/tmp/.cache/bun"\n' > /home/agent/.bunfig.toml \
 && printf 'cacheDir: /tmp/.cache/pnpm\nstateDir: /tmp/.cache/pnpm-state\nstoreDir: /tmp/.cache/pnpm-store\n' > /home/agent/.config/pnpm/config.yaml \
 && chown -R agent:agent /workspace /home/agent

COPY --chmod=0755 windlass /usr/local/bin/windlass
# Check the executable on the target architecture, before the image can be tagged.
RUN version="$(windlass --version)" && \
    release="$(echo "$version" | awk '$1 == "Windlass" { sub(/\+.*/, "", $2); if ($2 ~ /^[0-9]+\.[0-9]+\.[0-9]+$/) print $2 }')" && \
    { dpkg --compare-versions "$release" ge 0.4.0 || { echo "Windlass 0.4.0 or later is required; found $version" >&2; exit 1; }; }
COPY --chmod=0755 wlp-run /usr/local/bin/wlp-run
# `pnpm` runs the image's pnpm, or the version a project pins where a setup command put it in corepack's cache:
# Windlass's command sandbox has no network to fetch a pinned pnpm (wlp-pnpm says how it chooses).
ENV WLP_IMAGE_PNPM_VERSION=${PNPM_VERSION}
COPY --chmod=0755 wlp-pnpm /usr/local/bin/pnpm
RUN test "$(pnpm --version)" = "${PNPM_VERSION}"

USER agent
ENV HOME=/home/agent \
    LANG=C.UTF-8 \
    NO_COLOR=1
RUN git config --global user.name "Windlass agent" \
 && git config --global user.email "agent@windlass-platform.invalid" \
 && git config --global init.defaultBranch main \
 && git config --global advice.detachedHead false

WORKDIR /workspace
LABEL dev.windlass-platform=1
CMD ["sleep", "infinity"]

FROM base AS shots
USER root
ENV HOME=/root
ARG DEBIAN_FRONTEND=noninteractive
# Chrome's headless shell as paired by playwright-core. Playwright supplies the Linux arm64 build,
# Chrome for Testing the amd64 build. The digests pin the two release archives byte for byte.
ARG HEADLESS_SHELL_VERSION=149.0.7827.55
ARG HEADLESS_SHELL_ARM64_BUILD=1228
ARG PLAYWRIGHT_CORE_VERSION=1.61.1
ARG HEADLESS_SHELL_AMD64_SHA256=410c9407d5de3fea80d9398666be06f2aa09154a3fa7b327dc254e336bb4c4b7
ARG HEADLESS_SHELL_ARM64_SHA256=1652929a70f4afb17aca36fce073fb7ed22262d16825be761b0801972f43ac4f
ENV WLP_BROWSER=/opt/wlp-browser/chrome/headless_shell
RUN set -eu; cd /tmp; \
    apt-get update; apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcups2t64 \
      libdbus-1-3 libdrm2 libgbm1 libxkbcommon0 libx11-6 libxcb1 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libasound2t64 libpango-1.0-0 libcairo2 \
      fontconfig fonts-liberation fonts-dejavu-core; \
    case "$(dpkg --print-architecture)" in \
      amd64) dir=chrome-headless-shell-linux64; zip="$dir.zip"; sha="$HEADLESS_SHELL_AMD64_SHA256"; \
             url="https://cdn.playwright.dev/builds/cft/$HEADLESS_SHELL_VERSION/linux64/$zip" ;; \
      arm64) dir=chrome-linux; zip=chromium-headless-shell-linux-arm64.zip; sha="$HEADLESS_SHELL_ARM64_SHA256"; \
             url="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/$HEADLESS_SHELL_ARM64_BUILD/$zip" ;; \
      *) echo "unsupported browser architecture" >&2; exit 1 ;; \
    esac; \
    curl --retry 3 -fsSLO "$url"; printf '%s  %s\n' "$sha" "$zip" | sha256sum -c -; \
    unzip -q "$zip" -d /opt/wlp-browser; mv "/opt/wlp-browser/$dir" /opt/wlp-browser/chrome; \
    if [ "$dir" = chrome-headless-shell-linux64 ]; then ln -s chrome-headless-shell "$WLP_BROWSER"; fi; \
    ln -s "$WLP_BROWSER" /usr/local/bin/wlp-headless-shell; \
    printf 'export WLP_BROWSER=%s\n' "$WLP_BROWSER" > /etc/profile.d/wlp-browser.sh; \
    npm install -g --no-fund --no-audit "playwright-core@${PLAYWRIGHT_CORE_VERSION}"; \
    wlp-headless-shell --version; \
    npm cache clean --force; rm -rf /root/.npm; find /var/lib/apt/lists /tmp -mindepth 1 -delete; install -d -o agent -g agent /tmp/.cache
COPY --chmod=0755 wlp-shot /usr/local/bin/wlp-shot
USER agent
ENV HOME=/home/agent
