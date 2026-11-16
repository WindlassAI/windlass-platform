# The sandbox image of windlass-platform: one container per agent session.
# Built by sandbox/build.sh, which puts the Windlass binary into the build context as ./windlass.
FROM ubuntu:24.04

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
    node --version; npm --version; pnpm --version; bun --version; uv --version

# A non-root user. The data directory exists in the image owned by `agent`, so an empty named volume
# mounted there takes that ownership.
#
# Windlass's command sandbox lets a command write only in the workspace and in /tmp, and the package
# managers keep their caches in the home directory: there npm and uv fail, pip goes without a cache and
# pnpm puts its store into the project. So each is told, in its own configuration file, to keep its
# cache under /tmp/.cache, which a command can write with the sandbox and without it.
RUN useradd --create-home --uid 1000 --shell /bin/bash agent \
 && mkdir -p /workspace /home/agent/.local/share/windlass /home/agent/.config/pnpm /etc/uv /usr/local/etc \
 && chmod 700 /home/agent/.local/share/windlass \
 && printf 'cache=/tmp/.cache/npm\nupdate-notifier=false\n' > /usr/local/etc/npmrc \
 && printf '[global]\ncache-dir = /tmp/.cache/pip\n' > /etc/pip.conf \
 && printf 'cache-dir = "/tmp/.cache/uv"\n' > /etc/uv/uv.toml \
 && printf '[install.cache]\ndir = "/tmp/.cache/bun"\n' > /home/agent/.bunfig.toml \
 && printf 'cacheDir: /tmp/.cache/pnpm\nstateDir: /tmp/.cache/pnpm-state\nstoreDir: /tmp/.cache/pnpm-store\n' > /home/agent/.config/pnpm/config.yaml \
 && chown -R agent:agent /workspace /home/agent

COPY --chmod=0755 windlass /usr/local/bin/windlass
COPY --chmod=0755 wlp-run /usr/local/bin/wlp-run

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
