# Contributing to Windlass Platform

Windlass Platform is licensed by path: MIT for the code that runs on your machine and FSL-1.1-MIT for the
rest (see [NOTICE.md](NOTICE.md)). A contribution is licensed under the same license as the files it changes
(inbound equals outbound). Add a `Signed-off-by:` line to each commit (`git commit -s`) to certify the
[Developer Certificate of Origin](https://developercertificate.org/).

For bugs, questions or design ideas, [open an issue](https://github.com/WindlassAI/windlass-platform/issues/new)
or join the discussion on an existing issue. For bugs, include your operating system, Node.js
and pnpm versions, sandbox mode, steps to reproduce, and what you expected and observed.
Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

## Running the checks

Use Node.js 22.22.2 or a newer patch in the 22.x line, and pnpm 11.25.0. From the repository root:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm typecheck
WLP_SANDBOX=fake pnpm test
```

The root suite includes web tests and server integration tests. The latter start a local Rivet
engine and bind loopback ports. The fake Windlass sandbox replays fixtures, and the runner and
external services use stand-ins. Linux x64 and arm64 have native engine packages.

To exercise real Windlass tool calls, use a local Docker daemon on Linux and build the sandbox
image before running the server's Docker integration tests:

```sh
pnpm sandbox:build
pnpm --filter @windlass-platform/server e2e:docker
```

The sandbox build fetches the checksum-pinned Windlass release. See the [full list of checks](docs/development.md#checks)
for focused commands and the [quick start](README.md#quick-start) for an interactive demo.

## Maintainer pull requests

Keep each PR focused. Link the issue, describe the behavior change, and list the commands you ran,
their results and any checks you skipped. Include a screenshot for visible UI changes. To retake the README's
screenshots from the web app's mock, run `pnpm shots` (`pnpm shots --help` lists the options). Run the
fake suite for platform changes and the Docker checks when changing real sandbox behavior.
