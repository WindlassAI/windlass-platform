# The multi-platform Docker Official Image contains the static release CLI.
# The manifest-list checksum pins the download and both architecture-specific layers.
FROM docker:29.1.3-cli@sha256:4fa0ee1f3a7e4354c4ea34558b6d4ee32859baf4973d4c8ccc8e7fe3dd730c04 AS cli
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
# The slim Node image has no CA bundle; the Docker client needs one to inspect pinned indexes on a registry.
COPY --from=cli /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY sandbox-layout.json seccomp-bwrap.json seccomp-bwrap.LICENSE /usr/local/bin/
COPY --chmod=0755 runner.cjs /usr/local/bin/windlass-runner
LABEL dev.windlass-platform=1
ENTRYPOINT ["windlass-runner"]
CMD ["run"]
