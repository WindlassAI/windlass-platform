# Publishing a runner for self-hosted Machines

1. Deploy the server release to every server node. Keep the currently advertised runner settings during this step. The server accepts reports from older runners and understands the new catalog frames.
2. Publish the runner image. Use its immutable registry digest as `WLP_RUNNER_IMAGE`. Read the capabilities from that exact image on the release machine.

   ```sh
   export WLP_RUNNER_IMAGE='registry.example.org/windlass/runner@sha256:<published-digest>'
   docker run --rm --network none -e WLP_RUNNER_IMAGE "$WLP_RUNNER_IMAGE" capabilities
   ```

3. Update `WLP_RUNNER_IMAGE` and `WLP_RUNNER_CAPABILITIES` together in the optional server env file, then recreate the server services with that configuration. By default the file is `.data/selfhost/<compose-project>.server.env`. Set `WLP_RUNNER_CAPABILITIES` to the single-line JSON output of the command. Single quotes around the JSON value preserve the double quotes in a Compose env file. The Machines page offers the harnesses listed for the matching image digest.

[Example server env file](.env.example)
