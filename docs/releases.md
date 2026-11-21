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

1. On the release branch, dispatch **Release images** with a version and leave **push** disabled. Confirm the base, screenshots and both harness builds on each architecture. Dry runs pass the native base through a temporary OCI archive. The runner builds against the most recent published runner manifest when one exists. The first dry run records the runner skip in its job summary.
2. After review and CI on the protected main branch, the owner tags the intended commit `runner-v<version>`. Use a Docker-tag-compatible semantic version, such as `0.1.0` or `0.1.0-rc.1`. The tag starts publication. To repeat a failed run manually, select that same tag, supply its version, and enable **push**. This binds the signing certificate to the tag.
3. The workflow pushes each native build by digest, joins its manifests under `runner-v<version>` and `sha-<12 commit characters>`, then builds the runner against the four resulting indexes. BuildKit includes maximal provenance and an SBOM. Cosign signs all five index digests through GitHub OIDC. The release job signs the manifest, checks the pins from the same executable copied into the runner, verifies each index signature and creates a draft with both files.
4. Review the commit, Windlass and harness versions, each image's index and its two platform digests in the draft. Check public package visibility before publishing. If a package needs to be made public, the owner changes that package's visibility in GitHub. Making a package public is permanent.
5. Check all five digest pulls on a clean Docker host with empty registry credentials. The commands below use the draft's verified `release.json` in the current directory. Then publish the draft. The deploy operator can set `WLP_RUNNER_IMAGE` to the verified runner reference.

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
