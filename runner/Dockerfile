# The multi-platform Docker Official Image contains the static release CLI.
# The manifest-list checksum pins the download and both architecture-specific layers.
FROM docker:29.10.0-cli@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS cli
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
# The slim Node image has no CA bundle; the Docker client needs one to inspect pinned indexes on a registry.
COPY --from=cli /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY sandbox-layout.json seccomp-bwrap.json seccomp-bwrap.LICENSE /usr/local/bin/
COPY --chmod=0755 runner.cjs /usr/local/bin/windlass-runner
LABEL dev.windlass-platform=1
ENTRYPOINT ["windlass-runner"]
CMD ["run"]
