# Licensing

Windlass Platform has two licenses, split by where the code runs.

## Code that runs on your machine: MIT

These paths are under the MIT License ([LICENSE-MIT](LICENSE-MIT)):

- `runner/`: the runner you install on your own machine
- `sandbox/`: the images, scripts and helpers that run in or beside the sandboxes on that machine
- `server/src/runner/`: the runner protocol shared by the runner and the server
- `server/src/sandbox/`: the sandbox layer the runner bundles

You can use, change and redistribute this code freely, including in commercial products.

## Everything else: FSL-1.1-MIT

Everything else in this repository is under the Functional Source License, Version 1.1, with MIT as the Future License ([LICENSE.md](LICENSE.md)). That includes the server, the web app, the factory, the deployment kit and the scripts.

In short:

- You may read, use, change and self-host it, for yourself or your organization, and use it for internal purposes, research and non-commercial education.
- You may not offer it, or something substantially similar built from it, as a competing commercial product or service.
- Each version becomes available under the MIT License two years after it is released.

The license text decides; this summary does not.

## Third-party components

`sandbox/seccomp-bwrap.json` is derived from Docker's default seccomp profile and stays under its own license, Apache-2.0 ([sandbox/seccomp-bwrap.LICENSE](sandbox/seccomp-bwrap.LICENSE)). Dependencies keep their own licenses.
