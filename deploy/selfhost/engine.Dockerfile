FROM node:22-bookworm-slim AS binary
ARG TARGETARCH
# Install the same static binary package the locked SDK resolves for this target.
RUN arch="$TARGETARCH" && [ "$arch" != amd64 ] || arch=x64; \
    npm pack "@rivetkit/engine-cli-linux-${arch}-musl@3.1.1" --pack-destination /tmp && \
    tar -xzf /tmp/rivetkit-engine-cli-linux-*-musl-3.1.1.tgz -C /tmp package/rivet-engine

FROM debian:bookworm-slim
COPY --from=binary --chmod=755 /tmp/package/rivet-engine /usr/local/bin/rivet-engine
RUN mkdir -p /var/lib/rivet/log /var/lib/rivet/objects && chown -R 1000:1000 /var/lib/rivet
COPY deploy/selfhost/engine.json /etc/rivet/engine.json
USER 1000:1000
ENTRYPOINT ["rivet-engine","--config","/etc/rivet/engine.json"]
