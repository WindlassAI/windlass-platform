# Windlass on one Linux host

The server serves the built web app and platform HTTP routes. A separate Rivet 3.1.1 engine runs the actor gateway, scheduler and durable actor storage. The server opens an outbound node connection over the private Compose network. Staging uses demo sign-in, fake sandboxes and a runner stand-in for the load test.

The arm64 staging run includes per-probe timings and a restore of the measured timeline. [Validation results](VALIDATION.md)

## Bring up staging

Use Docker Engine, Compose v2.24 or later, Bash, Git and OpenSSL. Run these commands from the repository root.

```sh
deploy/selfhost/init-env.sh staging
stack=.data/selfhost/staging.env
dc() { docker compose --env-file "$stack" -f deploy/selfhost/compose.yaml "$@"; }
dc up -d --build --wait --wait-timeout 180
dc ps
curl -fsS http://127.0.0.1:16440/health
curl -fsS http://127.0.0.1:16440/ | head -c 80
```

The initializer creates a private, git-ignored, mode-600 file and refuses to overwrite it. Keep a protected copy of the env file with the corresponding release. New live stacks generate independent signing and sealing secrets. Staging and legacy stacks use the signing secret for sealing when WLP_SIGNIN_KEY is unset. Engine archives contain actor data and engine signing keys. Restrict access to both.

| Stack | Compose project | HTTP and web | Actor gateway | Initial volume |
|---|---|---|---|---|
| Staging | `wlp-staging` | `127.0.0.1:16440` | `127.0.0.1:16420` | `wlp-staging_engine-data` |
| Live | `wlp-live` | `127.0.0.1:26440` | `127.0.0.1:26420` | `wlp-live_engine-data` |

The two projects have separate networks, image tags, volumes and credentials. Each engine uses one leader and one writer to its volume. The volume contains both `log/` and `objects/`. The local filesystem object store supplies the cluster metadata and cold data. At first start the server waits for the admin API, creates the default namespace and pool if absent, then starts the registry. Readiness checks both the node's health and the server's ability to issue browser tokens.

### Routing and a future live stack

For a locally managed named tunnel, copy [the ingress example](tunnel.example.yml) to the tunnel service's config, set its UUID and mode-600 root-owned credential file, then substitute your two hostnames and the loopback ports for the selected stack. For a remotely managed tunnel, enter the equivalent ordered ingress rules in its remote configuration. The example uses staging ports. Live uses 26440 for web and 26420 for the engine. Keep the final `http_status:404` rule and preserve WebSocket upgrades. Keep token-bearing discovery responses uncached and exclude gateway URLs, query strings and WebSocket protocols from access logs. The engine's private Compose address serves node registration, bootstrap and token minting.

With RivetKit 3.1.1, browser and runner handles address actors by name and key. The gateway resolves the key in the query string. Browsers POST to `/gateway/{login,user,agentSession}/action/<action>` and subscribe at `/gateway/{user,agentSession}/connect`. Runners upgrade `/gateway/machine/websocket/control` and `/gateway/agentSession/websocket/runner`. Both clients disable metadata lookup. Leave the engine REST API private, including `/actors`, `/namespaces`, `/pools`, `/nodes`, `/envoys/connect` and `/auth/tokens`. [Gateway URL builder](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/engine-client/actor-websocket-client.ts) · [Action transport](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/client/actor-handle.ts) · [Socket paths](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/common/actor-router-consts.ts) · [Engine REST API](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/engine-client/api-endpoints.ts) · [Web client](../../web/src/api/rivet.ts) · [Runner client](../../runner/src/control.ts)

On a loopback demo stack, check the candidate rules before installation (substitute the configured hostnames). This uses cloudflared's offline matcher and a local reverse proxy to run a demo login and a paired stand-in runner turn. It creates demo actor data. With the staging `RIVET_ADMIN_TOKEN` in the check process environment, it also sends authenticated requests to the local edge. No Cloudflare account or tunnel connection is required.

```sh
cloudflared tunnel --config deploy/selfhost/tunnel.example.yml ingress validate
server/node_modules/.bin/tsx scripts/selfhost-ingress-check.ts deploy/selfhost/tunnel.example.yml app.example.com engine.example.com
```

At cutover, replace any whole-host engine route with the allowlist and validate the final configuration. Start or restart the connector with those rules, then route both DNS names to the configured tunnel. Confirm that `/namespaces` and `/auth/tokens` on the public engine hostname return the edge's 404, then sign in, open the session feed and confirm the paired runner completes a turn.

The engine supports an expiring namespace JWT with the `node` resource and `create` operation for node registration. Its only static engine credential is the admin token. The current server also bootstraps namespaces and pools and mints browser and runner credentials, which requires a persistent management credential. Isolating that credential from the server requires moving those operations to a private service and renewing the node JWT before reconnects (maximum lifetime 24 hours). [Node registration](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/pegboard-envoy/src/routes.rs) · [Wire resource names](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/auth-policy/src/types.rs) · [Issuance](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/api-public-shim/src/tokens.rs) · [Engine auth configuration](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/auth.rs)

Before first live boot, run `deploy/selfhost/init-env.sh live`, stage the target architecture's Windlass binary using `server/stage-windlass.sh`, and select the live env file in the commands above. Edit the application and gateway origins to the intended HTTPS names. Set the engine's canonical origin to that gateway name **before initializing its volume**. A tunnel may be installed later. The server issues tokens over Compose DNS, so the public hostname need not resolve from inside its container.

The gateway URL clients dial (`WLP_PUBLIC_ENDPOINT`) and the engine's canonical leader URL (`SELFHOST_ENGINE_ORIGIN`) are separate settings. The latter determines the JWT issuer persisted in the signing ring. Keep it stable for the life of the data, including restores. For an existing loopback staging volume, keep its original canonical URL when assigning it a client-facing hostname. Changing the issuer of an existing ring can produce `503 auth.issuance_unavailable` even with correct admin credentials.

The live preset selects the production image, disables demo login and runs real Windlass sign-in commands locally. Choose paired-machine sessions for workloads on a separate machine. The preset's hosted provider is fake. Configure a supported real provider separately if hosted sessions are required. Additional application settings, including the user allowlist, can go in a mode-600 server env file under `.data/selfhost/`. Configure and pair a runner for the intended stack independently. A runner paired to another deployment has its own identity and session data.

## Agents never run on the platform host

An agent container escape or a compromised runner with the Docker socket can expose the engine data, tunnel credentials and every user's sealed sign-ins and their decryption key. Keep hosted sandboxes set to `fake` or `e2b` and pair a runner on a separate machine, since running the owner's development agents under a root-equivalent account on the platform host exposes the same secrets.

Before opening an invitation-only deployment to traffic, verify that the effective live configuration
has demo sign-in disabled and at least one entry in `WLP_ALLOWED_USERS` or `WLP_ALLOWED_EMAILS`.
Empty lists admit any authenticated ChatGPT account. Confirm that staging and production use
independent credentials and that the gateway exposes only the intended routes listed above.
Record pass/fail results without printing the configuration values.

### Resource allocation

The engine has 4,096 CPU shares and a 2,304 MiB memory limit. The server has 3,072 shares and a 1,792 MiB memory limit. Both restart unless explicitly stopped. Size both stacks together on a 12 GB host.

### Configuration names

| Purpose | Variables |
|---|---|
| Project, ports, data and release | `COMPOSE_PROJECT_NAME`, `SELFHOST_HTTP_PORT`, `SELFHOST_GATEWAY_PORT`, `SELFHOST_VOLUME`, `SELFHOST_RELEASE`, `SELFHOST_SERVER_TARGET`, `SELFHOST_SERVER_ENV_FILE` |
| Public origins and canonical issuer | `WLP_PUBLIC_URL`, `WLP_PUBLIC_ENDPOINT`, `SELFHOST_ENGINE_ORIGIN`, `SELFHOST_ISSUER_GENERATION` |
| Credentials and node version | `WLP_SECRET`, `RIVET_ADMIN_TOKEN`, `RIVET_NODE_VERSION` |
| Application modes | `WLP_DEMO`, `WLP_SANDBOX`, `WLP_SIGNIN_RUNNER`, `WLP_REQUIRE_SIGNED_RUNNER` |
| Set by Compose for the server | `RIVET_ENDPOINT`, `RIVET_TOKEN`, `RIVET_NAMESPACE`, `RIVET_POOL`, `WLP_TOKEN_ENDPOINT`, `WLP_WEB_ORIGINS`, `WLP_MACHINES`, `WLP_HTTP_PORT` |
| Optional server settings | `WLP_SECRET_KEYS`, `WLP_SIGNIN_KEYS`, `WLP_SIGNIN_KEY`, `WLP_ALLOWED_EMAILS`, `WLP_ALLOWED_USERS`, `WLP_RUNNER_IMAGE`, `WLP_RUNNER_CAPABILITIES`, `WLP_PLATFORM_KEY`, `WLP_BUCKET_*` |

The default optional server env file is `.data/selfhost/<compose-project>.server.env`. An explicit relative path is resolved from the Compose file's directory. Stack settings listed under `environment` in Compose take precedence over this file. Avoid printing expanded Compose configuration or unfiltered container inspections.

### Enable signed runner connections

Leave `WLP_REQUIRE_SIGNED_RUNNER=0` in the stack env file for the initial server deployment. This is the
default for existing stacks as well. Protocol-1 runners can keep their current image and pairing.
Switch every server node together when the owner is ready to update and re-pair the machines.

1. On the **owner's laptop**, in a checkout of this release with dependencies installed, run the following
   commands. Use a private directory on owner-controlled offline storage for the root. The output file
   for the certified **online** key is a deployment secret. The root command refuses to overwrite a file.

   ```sh
   umask 077
   root=/path/on/offline-storage/wlp-platform-root.pem
   pnpm --filter @windlass-platform/server exec tsx ../scripts/platform-key.ts root --out "$root"
   pnpm --filter @windlass-platform/server exec tsx ../scripts/platform-key.ts fingerprint --root "$root"
   pnpm --filter @windlass-platform/server exec tsx ../scripts/platform-key.ts certify --root "$root" --serial 1 --days 90 > /path/to/private-transfer/platform-online.env
   ```

2. Keep the root and its backup offline. Record its public fingerprint independently. Transfer only
   `platform-online.env` through the deployment's secret channel. Install its single `WLP_PLATFORM_KEY`
   line in the mode-600 optional server env file (live default `.data/selfhost/wlp-live.server.env`).
   Keep both the env file and generated key material outside Git, images, logs and chat.
3. Stage the **0.2.0** runner at a new immutable digest. Keep the old setup command available until cutover. Set the new pinned `WLP_RUNNER_IMAGE` and matching
   `WLP_RUNNER_CAPABILITIES` in that server env file. To obtain the capabilities JSON, export the new
   `WLP_RUNNER_IMAGE` digest reference and run `docker run --rm --network none -e WLP_RUNNER_IMAGE "$WLP_RUNNER_IMAGE" capabilities`.
   Set `WLP_REQUIRE_SIGNED_RUNNER=1` in
   `.data/selfhost/live.env`. Recreate the server and check health.

   ```sh
   docker compose --env-file .data/selfhost/live.env -f deploy/selfhost/compose.yaml up -d --no-deps --force-recreate --wait server
   curl -fsS http://127.0.0.1:26440/health
   ```

4. On each runner host, stop and remove the old runner container (`docker rm -f windlass-runner` for the
   default name), retaining its named state volume. On the Machines page choose **Add a machine**, run
   its setup command with the same volume and approve the new pairing. Compare the printed fingerprint
   with the offline fingerprint. Run the background command printed by setup and
   confirm it appears online and completes a turn. Each new pairing has a new machine id. Old pairings
   and their workspaces stay associated with their original ids.

Schedule renewal before the certificate expires. Expiry prevents new handshakes, including reconnects.

For renewal or a leaked online key, run `certify` again under the same root with the next unused serial.
Replace the online env line on every server and recreate the services. Reconnect each runner so it
records the higher serial. A disconnected runner can still accept its previous unexpired certificate
until it sees the newer serial. For a gateway move, also pass `--endpoint https://new-gateway.example`
to `certify` and update `WLP_PUBLIC_ENDPOINT` together with that certificate. Include the same gateway
origin on subsequent certificates until every runner has recorded the move. A lost root requires a new
root and a fresh pairing on every runner. Reverting the server switch restores protocol 1 for old runners.
Pinned runners require a signed platform on their next connection.

For the public origins, the owner should enable hardware-key 2FA and auditing on the Cloudflare account,
use scoped API tokens, enable DNSSEC for `parthg.dev` and restrict CAA to the CA used for the edge
certificate. Check `dig CAA parthg.dev` after edge certificate renewal. The deployment does not verify CAA.

### Migrate existing sign-ins at cutover

If a deployment already sets `WLP_SIGNIN_KEY`, retain that exact key. If it used the `WLP_SECRET` fallback, verify privately that the old signing secret is at least 32 characters long, then replace the generated `WLP_SIGNIN_KEY` with that exact old value in the protected live stack env file. Pause the migration if the old secret is shorter: existing blobs need a separate re-sealing migration. Generate a **new** 32-byte random hex `WLP_SECRET` in the private configuration and apply the two settings together on every server. This signs users out of the platform while preserving sealed ChatGPT sign-ins and repository secrets. Retain protected copies of both keys for disaster recovery. When both stack and optional server env files provide the seal key, the stack value wins. An explicitly empty key is invalid.

### Rotate signing and sealing keys

The **first deployment of this release ends existing 30-day platform sessions**, including the owner’s browser session. Sign in again. Finish any GitHub connection already underway before upgrading, or restart it afterward. Existing GitHub installations, saved ChatGPT sign-ins, and account and repository secrets survive when their original sealing material is retained. Switch all servers to this release together. Older servers cannot verify the new tokens.

In the mode-600 optional **server env file**, set `WLP_SECRET_KEYS` for platform signatures and `WLP_SIGNIN_KEYS` for encryption. Each is an ordered comma-separated list of `id:secret` entries. The first entry issues new material and every entry can read material bearing its id. Use a distinct `openssl rand -hex 32` value per root and keep its id for its lifetime. Ids permit 1–32 letters, digits, underscores or dashes. Each list overrides its single-key setting. Without a dedicated sealing setting, encryption follows the signing keyring, so retiring a signing root also retires its decryption capability.

1. Back up the actor data and its corresponding protected configuration. For the initial conversion from singleton settings, use `default` as the id of the exact existing `WLP_SECRET` to retain sessions issued by this release. Put the exact existing seal secret in the sealing ring under a stable id. Legacy ciphertext carries a derived id that the reader recognizes automatically. Switch all servers together for this first conversion, because a singleton seal reader only recognizes the derived id.
2. Before each subsequent rotation, distribute the old and new roots to every server with the **old entry first**. For example, the signing list has the form `default:<existing>,nov26:<new>`. Recreate the server with `dc up -d --no-deps --force-recreate --wait server` for each configuration change. Once all readers have both entries, promote the new root by reversing the order on each server. Signing and sealing can rotate independently.
3. For routine signing rotation, keep the old entry for 30 days after the last server stopped issuing with it. Removing it sooner ends any remaining sessions signed under that id. For a compromised root, remove it immediately across all servers and sign in again. Keep the required Compose `WLP_SECRET` and any singleton sealing fallback aligned with the current roots when retiring old material, to keep retired root material off the server. Keep the named rings configured so previously issued ids remain recognizable.
4. For sealing rotation, check the saved ChatGPT sign-in and use each account and repository secret after promotion. Reading stored material re-seals it with the current key. Opening a metadata-only secret list leaves the ciphertext untouched. Re-save dormant values individually or retain the previous key until every needed value has been migrated. Allow pending sign-in attempts to finish or expire. Verify a restored copy with only the new key before dropping the previous key from servers. Keep the old key protected alongside any historical backups that still require it.

### Revoke one user's platform sessions

**Settings → Sign-in → Sign out everywhere** ends the current browser session and the user's other platform sessions. To do the same as an operator, run the following inside the selected stack using its existing server configuration. Substitute the platform uid.

```sh
dc exec -T server node --import tsx src/revoke-user-tokens.ts u_example
```

The user's actor stores the new token generation durably and closes existing user and agent-session feeds. If a session actor is temporarily unreachable, the server retries its feed cleanup. Every subsequent user action checks the new generation. Their next login receives that generation. Running agents, saved credentials, paired machines and independently managed API tokens keep working. Restoring actor data also restores the generations in that backup. After a restore, revoke affected uids again before reopening the gateway if more recent sign-outs must be honored.

## Backup and restore

Use a Linux amd64 or arm64 host with curl, GNU tar and coreutils, `flock`, Python 3, gzip and the AWS CLI for S3. Grant the backup credentials list/get/put/delete access to the project's prefix. Provide the backup environment through the operator's secret store. The scripts use a separate set of names from the platform's sandbox bucket.

| Purpose | Variables |
|---|---|
| S3-compatible destination | `SELFHOST_BACKUP_ENDPOINT`, `SELFHOST_BACKUP_REGION`, `SELFHOST_BACKUP_BUCKET`, `SELFHOST_BACKUP_ACCESS_KEY_ID`, `SELFHOST_BACKUP_SECRET_ACCESS_KEY` |
| Encryption and recovery | `SELFHOST_BACKUP_AGE_RECIPIENT` (public key), `SELFHOST_BACKUP_AGE_IDENTITY` (identity file path at restore time) |
| Retention and local directory backend | `SELFHOST_BACKUP_KEEP`, `SELFHOST_BACKUP_DIR` |

Generate an age keypair on the recovery machine with `age-keygen -o windlass.agekey`. Keep the private identity off the platform host, with a protected recovery copy. Give the backup job only the public recipient (`age-keygen -y windlass.agekey`). The scripts download [age v1.3.2](https://github.com/FiloSottile/age/releases/tag/v1.3.2) for the host architecture and verify the release archive against its pinned SHA-256 before extracting the binary on each use. For offline operation, pre-stage the matching release tarball under `.data/selfhost/tools/`. Protect temporary plaintext tar files and allow space for both the gzip and encrypted archive.

```sh
export SELFHOST_BACKUP_AGE_RECIPIENT='age1...'  # public recipient
archive=$(deploy/selfhost/backup.sh "$stack")
# On the recovery machine, with the same store configuration:
export SELFHOST_BACKUP_AGE_IDENTITY=/secure/recovery/windlass.agekey
fresh=$(deploy/selfhost/restore.sh "$stack" "$archive")
```

Both services must be running before a backup. The script stops the server first so actors can finish shutdown, stops the engine, checks both exit statuses and archives the whole mounted volume. The engine CLI exposes storage operations but no whole-engine online snapshot command. Stopping all writers gives the log and object store a common point in time. The script restarts the services immediately after the local tar copy, then compresses, encrypts and publishes the archive. An interrupted copy triggers a restart attempt. Allow space under `.data/selfhost` for the uncompressed tar and archive. Downtime depends on graceful shutdown, data size and disk throughput. Check `dc ps` after recovery.

Objects are stored at `<bucket>/<compose-project>/<archive-basename>`. After a successful upload, retention keeps the newest N timestamped snapshots for that project (default seven). Other object names and other projects' prefixes are preserved. On a versioned S3 bucket configure a bucket lifecycle for old versions and abandoned multipart uploads. For a local-only drill set `SELFHOST_BACKUP_DIR` to a private directory. It takes precedence over S3. Only a local directory accepts an explicit plaintext backup: unset the recipient and set `SELFHOST_BACKUP_PLAINTEXT=1`. Both backends can restore legacy `.tar.gz` objects. Retention counts those alongside `.tar.gz.age` snapshots. Existing plaintext objects and older bucket versions need a separate retirement decision after a verified encrypted restore.

Restore loads a named archive into a newly generated volume, prints its name and leaves the running stack alone. For a replacement host, build or load the matching engine image first. Restore the original stack secrets, project and canonical origin. To switch volumes during a maintenance window, stop the services, save the previous volume name, edit `SELFHOST_VOLUME` in the private stack env file to the printed name, and run `dc up -d --no-build --wait`. Verify a known user's session and timeline before retiring the previous volume. A smoke-test proof can be checked with the command below. These archives cover engine state. Runner workspaces, credentials on the runner, sandbox files, and optional bucket contents have independent backup requirements.

## Test the stack

Install workspace dependencies using `pnpm install --frozen-lockfile`. Run from the repository root against a local, demo-enabled stack with fake sandboxes.

```sh
server/node_modules/.bin/tsx scripts/selfhost-load.ts \
  --origin http://127.0.0.1:16440 --project wlp-staging \
  --sessions 4 --minutes 25 --burners --interval 10 --baseline 60 \
  --proof .data/selfhost/load-proof.json
# After restoring and switching to the new volume:
server/node_modules/.bin/tsx scripts/selfhost-load.ts \
  --origin http://127.0.0.1:16440 --project wlp-staging \
  --verify .data/selfhost/load-proof.json
```

The generator signs in as a new demo user, pairs an in-process runner, opens K independent sessions and sends each another short turn after its previous turn ends. The fixture spaces ACP thoughts, text, tool calls and plan updates 250 ms apart. The optional burners are isolated, networkless containers with the agent CPU and memory settings above. An idle baseline precedes load. The test lets in-flight turns finish, removes the burners and samples recovery. It retains the demo account and timeline on the test stack. The optional mode-600 proof contains a demo credential and a digest of the persisted timeline. Use a fresh proof filename for each run.

Every probe interval launches four concurrent reads, with a 30 s deadline per read. The page probe reads and checks the HTML. Actor probes use the browser's scoped token and read the user's session list, models and one rotating session's snapshot. The report prints successful-sample p50/p95/max in milliseconds (nearest rank), errors, completed turns, streamed updates, log severity and stall-signature counts, and engine/server restart deltas per run. Samples are grouped by request start time into idle, first 15 minutes, subsequent load and recovery. The load test can be interrupted with Ctrl-C.

The served page allows scripts and fonts from its own origin, inline styles, and HTTP and WebSocket connections to the configured `WLP_PUBLIC_ENDPOINT` origin. Set this endpoint at runtime when using a custom gateway. The page forbids framing. An HTTPS `WLP_PUBLIC_URL` enables one-year HSTS on web responses, including behind a tunnel that reaches the server over HTTP.

To check the built app on a loopback demo stack, run `node scripts/selfhost-csp-check.cjs http://127.0.0.1:16440` with Playwright and its Chromium available to Node. Set `CHROMIUM_EXECUTABLE` to use an installed Chromium. The check signs in to the demo, receives a user actor WebSocket frame, and attempts an inline script insertion in the rendered page.

## Logs, upgrade and rollback

```sh
dc ps
dc logs --since 10m engine server
dc logs -f server
```

Docker rotates the services' JSON logs at 32 MiB with up to three files per service. Inspect the node's health and gateway token availability after restarts. Restrict access to raw logs.

1. Record the current Git revision, engine and server image tags, private configuration and volume name. Take a backup at a quiet point.
2. Build the new revision under a new `SELFHOST_RELEASE` tag and increase `RIVET_NODE_VERSION`. Run `dc build` and test it in staging.
3. In a maintenance window run `dc stop server engine`, then `dc up -d --no-build --wait`. Check the web page, token issuance and a known actor read.
4. To roll back, select the previous sources (including the bootstrap script), prior images and configuration. If the new engine or actor code migrated data, restore the pre-upgrade backup to a fresh volume and point `SELFHOST_VOLUME` there before restarting. Writes since that backup remain on the upgraded volume. Keep both volumes until verification is complete.

## Rivet 3.1.1 implementation references

The installed SDK reads the endpoint, token, namespace, pool and node version, then starts the serverful registry. The engine CLI resolver selects the static Linux binary for the architecture. The installed generated API declares namespace creation and the pool upsert. [SDK environment](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/utils/env-vars.ts) · [Registry configuration](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/registry/config/index.ts) · [Registry listener](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/registry/index.ts) · [Pool API](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/engine-client/api-endpoints.ts) · [CLI resolver](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/engine-cli/index.js)

The npm engine package contains the executable. The matching tagged Rust source defines the two persistent paths, automatic single-node partition provisioning, environment overrides, admin authentication and derivation of the JWT issuer from the leader's public URL. [Storage validation](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/mod.rs) · [Storage log and partitions](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/depot.rs) · [Filesystem object store](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/object_storage.rs) · [Configuration loader](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/lib.rs) · [Topology](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/topology.rs) · [Authentication](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/auth.rs)
