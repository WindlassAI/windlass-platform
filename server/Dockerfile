# The server as one Rivet node, for a Rivet Cloud cluster's hosted node or for a machine of your own.
#
#   server/stage-windlass.sh                                                  once, and after a new Windlass build
#   docker build -f server/Dockerfile .                                       from the repository root
#   rivet deploy --cluster <cluster> --dockerfile server/Dockerfile --build-context .
#
# There is no Docker inside it, so the Docker sandbox layer cannot run here: start it with WLP_SANDBOX=e2b.
# The engine is not in it either. RIVET_ENDPOINT names the one it joins (a Rivet Cloud cluster sets it
# for its own nodes), and WLP_SECRET must be set, to the same value on every server, or it refuses to
# start. README, "Running on several servers", has the variables.

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
	PNPM_HOME=/pnpm \
	PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
# tsx is a dev dependency and runs the server's TypeScript as it is, so dev dependencies are installed too.
# RivetKit's native module for this platform (@rivetkit/rivetkit-napi-linux-*) is picked by the install.
RUN pnpm install --frozen-lockfile --filter @windlass-platform/server --prod=false

COPY server/tsconfig.json server/
COPY server/src server/src
# The fake layer replays these; config.ts names the directory.
COPY fixtures fixtures

# Windlass, for the sign-in commands the server runs itself (`windlass login ...`, server/src/signin/):
# a build for this image's architecture with `login token --valid-for`. The turns do not use it: they
# run in the sandbox provider's own image. server/stage-windlass.sh puts the builds where this line
# finds them; run it before building.
ARG TARGETARCH
COPY --chmod=0755 server/vendor/windlass-linux-${TARGETARCH} /usr/local/bin/windlass
ENV WLP_WINDLASS_BIN=/usr/local/bin/windlass

# Actor data is the engine's; this directory only ever holds what RivetKit writes for itself.
RUN mkdir -p /app/.data && chown node:node /app/.data
USER node

WORKDIR /app/server
ENV WLP_SANDBOX=e2b
# Rivet Cloud serves the port in PORT at the pool's public address; elsewhere WLP_HTTP_PORT or 6440.
EXPOSE 6440
CMD ["node", "--import", "tsx", "src/index.ts"]
