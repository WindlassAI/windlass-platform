# The server as one Rivet node, for a Rivet Cloud cluster's hosted node or for a machine of your own.
#
#   server/stage-windlass.sh                                                  once, and after a new Windlass build
#   docker build -f server/Dockerfile .                                       from the repository root
#   rivet deploy --cluster <cluster> --dockerfile server/Dockerfile --build-context .
#
# There is no Docker inside it, so the Docker sandbox layer cannot run here: start it with WLP_SANDBOX=e2b.
# The engine is not in it either. RIVET_ENDPOINT names the one it joins (a Rivet Cloud cluster sets it
# for its own nodes), and WLP_SECRET must be set, to the same value on every server, or it refuses to
# start. docs/operating.md, "Running on several servers", has the variables.

# The image is built for the machine that runs it on the machine that builds it, which may be of another
# architecture (`rivet deploy` builds linux/amd64, also on an arm64 machine): the first stage runs on the
# builder and installs the dependencies for the target, and the second only copies, so nothing of the
# target's architecture is run during the build.

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS deps
ARG TARGETARCH
ENV PNPM_HOME=/pnpm \
	PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
# tsx is a dev dependency and runs the server's TypeScript as it is, so dev dependencies are installed too.
# The native modules (RivetKit's @rivetkit/rivetkit-napi-linux-*, esbuild's) are the target's, not the builder's.
RUN cpu="$TARGETARCH" && [ "$cpu" != amd64 ] || cpu=x64 \
	&& pnpm install --frozen-lockfile --filter @windlass-platform/server --prod=false --os linux --cpu "$cpu" --libc glibc
# Actor data is the engine's; this directory only ever holds what RivetKit writes for itself.
RUN mkdir -p /app/.data

# The web app's files are the same for every architecture, so they are built on the builder too. Built
# with nothing set, the web app asks the address it was loaded from for its connection (web/src/api/rivet.ts).
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
ENV PNPM_HOME=/pnpm \
	PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @windlass-platform/web
COPY web web
# The files the web app shares with the server, and the recorded runs its mock replays.
# The web app imports shared server modules (contract, plan and placement rules); copy them all so a new import cannot break the image.
COPY server/src server/src
COPY fixtures fixtures
# `vite build` alone: the web app's own `build` type-checks first, tests included, and those reach into the server's sources.
RUN pnpm --filter @windlass-platform/web exec vite build

FROM node:22-bookworm-slim AS server-base
ARG TARGETARCH
ENV NODE_ENV=production

WORKDIR /app
COPY --from=deps /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/server server
COPY --from=deps --chown=node:node /app/.data .data
COPY server/tsconfig.json server/
COPY server/src server/src
COPY sandbox/seccomp-bwrap.json sandbox/seccomp-bwrap.LICENSE sandbox/
# The fake layer replays these; config.ts names the directory.
COPY fixtures fixtures

# The web app, served by this server on its own port: the platform has one address.
COPY --from=web /app/web/dist /app/web/dist
ENV WLP_WEB_DIR=/app/web/dist

USER node

WORKDIR /app/server
ENV WLP_SANDBOX=e2b
# Rivet Cloud serves the port in PORT at the pool's public address; elsewhere WLP_HTTP_PORT or 6440.
EXPOSE 6440
CMD ["node", "--import", "tsx", "src/index.ts"]

# Demo staging uses the in-memory sign-in and sandbox providers.
FROM server-base AS demo
ENV WLP_SANDBOX=fake

FROM server-base AS production
# Windlass, for the sign-in commands the server runs itself (`windlass login ...`, server/src/signin/):
# a build for this image's architecture with `login token --valid-for`. The turns do not use it: they
# run in the sandbox provider's own image. server/stage-windlass.sh puts the builds where this line
# finds them; run it before building.
COPY --chmod=0755 server/vendor/windlass-linux-${TARGETARCH} /usr/local/bin/windlass
ENV WLP_WINDLASS_BIN=/usr/local/bin/windlass
