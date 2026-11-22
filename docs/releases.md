# Runner image releases

A runner release contains five Linux image indexes in GHCR. Each index contains native amd64 and arm64 manifests. The runner embeds the four sibling index digests. Docker selects the matching manifest and verifies the digest on pull. The egress proxy, forward helpers and Claude and OpenCode relays use the base sandbox with scripts shipped in the runner.

| Entry in `release.json` | GHCR package under `ghcr.io/windlassai/` |
| --- | --- |
| `runner` | `windlass-runner` |
| `sandbox` | `windlass-platform-sandbox` |
| `sandbox-shots` | `windlass-platform-sandbox-shots` |
| `claude` | `windlass-platform-claude` |
| `opencode` | `windlass-platform-opencode` |

## Verify before setup

Choose the published runner tag on the [release page](https://github.com/WindlassAI/windlass-platform/releases). Use cosign v3 and set `tag` to that exact tag. Both commands check the same GitHub Actions workflow identity and issuer.

```sh
tag=runner-v0.1.0  # replace with the chosen release
repo=WindlassAI/windlass-platform
gh release download "$tag" --repo "$repo" -p release.json -p release.json.sigstore.json
signer="https://github.com/$repo/.github/workflows/release-images.yml@refs/tags/$tag"
issuer=https://token.actions.githubusercontent.com

cosign verify-blob --bundle release.json.sigstore.json \
  --certificate-identity "$signer" --certificate-oidc-issuer "$issuer" release.json

runner=$(jq -er '.images.runner | .ref + "@" + .index' release.json)
cosign verify --certificate-identity "$signer" --certificate-oidc-issuer "$issuer" "$runner"
printf '%s\n' "$runner"
```

Compare the full reference printed above with the runner digest in the Machines setup command. Start setup with that verified reference. It checks the daemon architecture, pulls the base sandbox and each selected harness, and displays Docker's progress before pairing. Add `--screenshots` to fetch and enable the screenshots variant. The service command printed after pairing reuses the verified reference. A locally built runner started by tag or ID prints its local immutable ID.

## Cut a release

1. Push the branch with `git push git@github.com:WindlassAI/windlass-platform.git release-images`, open a PR into `main`, and merge it after review and CI. GitHub requires the workflow file on the default branch before accepting its first manual dispatch. [GitHub workflow dispatch requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
2. Dispatch a build from `main`. Choose an unused Docker-compatible semantic version. The examples use `0.1.0`.

   ```sh
   repo=WindlassAI/windlass-platform
   version=0.1.0
   tag=runner-v$version
   gh workflow run release-images.yml --repo "$repo" --ref main -f version="$version" -f push=false
   ```

3. Open that dispatch in Actions. Check that the base sandbox, screenshots sandbox, Claude and OpenCode jobs succeeded on **both** amd64 and arm64. The harness jobs use the dry run's native base OCI archive. On the first release, the runner job records a skip because there is no previously published manifest. Once the dry run succeeds, copy its run ID into the commands below. Tagging that run's exact commit keeps a later merge to main out of the release.

   ```sh
   run_id=123456789  # replace with the successful dry run ID
   commit=$(gh run view "$run_id" --repo "$repo" --json headSha --jq .headSha)
   git fetch origin main
   git tag "$tag" "$commit" &&
     git push git@github.com:WindlassAI/windlass-platform.git "refs/tags/$tag"
   ```

4. Wait for the tag workflow. It publishes the five indexes under `runner-v<version>` and `sha-<12 commit characters>`, with BuildKit provenance, SBOMs and keyless cosign signatures. It signs the manifest and verifies the runner's embedded pins and all five index signatures before creating the draft. To retry a failed run, use **Re-run failed jobs** on that tag run or dispatch the workflow at the same tag with its version and **push** enabled.
5. As the owner, download both draft assets into an empty directory and verify the manifest signature using **Verify before setup**. Compare its version and commit with the tag and dry-run commit. Review the Windlass and harness versions and both platform digests for each image. Check all five GHCR packages. If one is private, open its **Package settings → Change visibility → Public**. GitHub makes that change permanent. Verify the runner signature at the digest in that manifest.
6. On a clean Docker host, test anonymous pulls of every verified index with empty registry credentials. Publish the draft after all five pulls succeed.

```sh
(
  set -eu
  docker_config=$(mktemp -d)
  trap 'rm -rf "$docker_config"' EXIT
  export DOCKER_CONFIG="$docker_config"
  jq -er '.images[] | .ref + "@" + .index' release.json > "$docker_config/refs"
  while IFS= read -r ref; do docker pull "$ref"; done < "$docker_config/refs"
)
```

Publish the reviewed draft in GitHub Releases. For deployment, update all server nodes to the compatible version first. Read `capabilities` from the verified runner, then advertise `WLP_RUNNER_IMAGE` and `WLP_RUNNER_CAPABILITIES` together so Machines offers the correct harnesses. [Self-hosted deployment order and commands](../deploy/selfhost/runner-release.md)

## Developer checks

From the workspace root, `pnpm check:release` checks workflow permissions, action pins, build arguments, bundle scanning and the release gate. The setup and architecture regressions run with `node --test scripts/runner-setup-check.mjs`. Run `actionlint .github/workflows/ci.yml .github/workflows/release-images.yml` to check Actions syntax and expressions.

`sandbox/build.sh --context <empty-dir>` stages the checksum-pinned native binary and Dockerfile. Set `WLP_SANDBOX_VARIANT=shots` for the screenshots context. `scripts/runner-build.sh --screenshots <sandbox-pin> <shots-pin>` accepts `WLP_RUNNER_HARNESSES="claude=<ref>@<digest> opencode=<ref>@<digest>"`. Local builds print the image ID. `WLP_RUNNER_PLATFORMS` and `WLP_RUNNER_ARCHIVE` select OCI export. The release workflow uses `WLP_RUNNER_PUSH=ghcr.io/windlassai/windlass-runner:runner-v<version>` and captures the pushed index digest.

## First public release on Docker Desktop

On Apple silicon, enable the default Docker socket and the containerd image store. Record `docker version`, `docker info --format '{{.Driver}} {{.DriverStatus}}'` and `docker run --rm alpine uname -r`. Verify the release above, then start setup with the selected harnesses and restricted egress.

```sh
docker run -it --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner "$runner" setup \
  --platform https://windlass.parthg.dev --name MacBook \
  --harness claude --harness opencode --egress restricted
```

Approve pairing, sign in, and start the printed service command. Record the pulls, service restart policy, internal session network, egress helpers and relay socket volumes. Check that neither relay publishes a host port. Complete a Claude turn and an OpenCode public-model turn. From a restricted Claude session, check that unlisted public sites, the host, LAN gateway and cloud metadata addresses are refused. Confirm the session sees only the relay placeholder and record the Machines page's command-sandbox probe on LinuxKit.

Restart Docker Desktop, then test sleep and wake with an idle session. Confirm reconnection and that logging Claude out makes the next Claude turn report signed out. Record the results in the Mac runner check and integration checklist.
