# The sandbox image of windlass-platform: one container per agent session.
# Built by sandbox/build.sh, which puts the Windlass binary into the build context as ./windlass.
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

# What Windlass needs (bubblewrap for its command sandbox, GNU env from coreutils, git for undo
# snapshots) and what an agent needs to do useful work. procps gives the platform `pkill -s` to stop
# everything a turn started.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap git ripgrep coreutils ca-certificates curl python3 python-is-python3 nodejs npm procps \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* \
 && if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi

# A non-root user. The data directory exists in the image owned by `agent`, so an empty named volume
# mounted there takes that ownership.
RUN useradd --create-home --uid 1000 --shell /bin/bash agent \
 && mkdir -p /workspace /home/agent/.local/share/windlass /home/agent/.config \
 && chmod 700 /home/agent/.local/share/windlass \
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
