# Staging validation, 21 November 2026

Test host: Oracle Ampere, Linux arm64, two CPUs, 12 GB nominal RAM. Baseline source: `7bc117c`. The staging web and gateway ports were 16440 and 16420. All platform traffic in these checks stayed on loopback or the private Compose network. Production services, public tunnels and real agent credentials were outside the test.

## Bring-up and gateway

From the repository root, the first build and start used an empty engine volume. The engine started first while the server image finished building.

```sh
deploy/selfhost/init-env.sh staging
stack=.data/selfhost/staging.env
dc() { docker compose --env-file "$stack" -f deploy/selfhost/compose.yaml "$@"; }
dc build
dc up -d --no-build engine
dc up -d --no-build --wait --wait-timeout 180
curl -fsS http://127.0.0.1:16440/health
curl -fsS http://127.0.0.1:16440/ | head -c 80
docker exec wlp-staging-engine-1 rivet-engine --runtime-info
```

The page returned HTTP 200 with `<!doctype html>`. Health and platform info returned HTTP 200. `/platform/connection` issued an expiring token for the default namespace and advertised `http://127.0.0.1:16420`. The engine returned 401 for an unauthenticated namespace list and 403 for a pool list using the browser token. Its runtime identified itself as engine v3, version 3.1.1. The arm64 engine executable in the image and the installed npm package both had SHA-256 `a27caab5a55b1a45df3a07025026416aab1fd6a98fa2449fe18eee82d7c06714`. The configuration and registration sources are linked in the [self-hosting guide](README.md#rivet-311-implementation-references).

## Stream and storage recovery

```sh
server/node_modules/.bin/tsx scripts/selfhost-load.ts --sessions 1 --minutes .12 \
  --interval 5 --baseline 5 --proof .data/selfhost/smoke-proof.json
export SELFHOST_BACKUP_DIR="$PWD/.data/selfhost/archives"
archive=$(deploy/selfhost/backup.sh "$stack")
fresh=$(deploy/selfhost/restore.sh "$stack" "$archive")
SELFHOST_VOLUME="$fresh" dc up -d --no-build --force-recreate --wait --wait-timeout 180
server/node_modules/.bin/tsx scripts/selfhost-load.ts --verify .data/selfhost/smoke-proof.json
```

Two successful turns emitted 58 ACP updates. The restored user listed the session, and the first 39 persisted timeline items matched SHA-256 `fc5290410b89048e92305ad3f7c88b3c901e7abe087a32ae324543f6bdf74b41`. The original staging volume was put back into service and the drill volume removed.

An additional S3-compatible drill used the AWS CLI and a loopback Moto test server. With `SELFHOST_BACKUP_DIR` unset and `SELFHOST_BACKUP_KEEP=1`, the scripts uploaded an archive, expired an older snapshot under the same project prefix and preserved an unrelated object. Download and restore into a fresh volume reproduced the same 39-item digest through a separate Compose project on ports 18440 and 18420. The restored engine retained the original canonical issuer while clients dialed the new gateway port. Using the new port as the canonical issuer instead returned 503 during JWT issuance, including in a trial with a higher issuer generation.

## Workload

```sh
server/node_modules/.bin/tsx scripts/selfhost-load.ts \
  --origin http://127.0.0.1:16440 --project wlp-staging \
  --sessions 4 --minutes 25 --burners --interval 10 --baseline 60 \
  --proof .data/selfhost/load-proof.json
```

The 25-minute measurement ran from 09:04:06 to 09:29:06 UTC. Final in-flight turns and burner removal finished at 09:29:12. Each session completed 208 turns, emitted 6,032 ACP updates and delivered 3,536 live deltas to its subscriber. Total: **832 successful turns, 24,128 updates, zero failed turns**. The local probes made 600 reads during load, with zero failures. The page probe fetched the HTML document. It did not measure browser rendering or asset downloads.

Each cell gives **p50 / p95 / maximum in milliseconds**. Combined percentiles use all four probes' individual samples. All table cells had zero errors.

| Probe | Idle (6 per probe) | Load 0–15 min (90 per probe) | Load 15–25 min (60 per probe) | Recovery (6 per probe) |
|---|---:|---:|---:|---:|
| Web page | 20 / 63 / 63 | 14 / 75 / 229 | 11 / 45 / 484 | 7 / 14 / 14 |
| User listSessions | 26 / 64 / 64 | 19 / 76 / 242 | 17 / 42 / 484 | 11 / 15 / 15 |
| User models | 28 / 65 / 65 | 21 / 105 / 242 | 17 / 42 / 566 | 12 / 17 / 17 |
| Full session snapshot | 35 / 67 / 67 | 57 / 138 / 298 | 104 / 194 / 763 | 82 / 112 / 112 |
| **All probes** | 28 / 65 / 67 | 24 / 119 / 298 | 19 / 150 / 763 | 12 / 105 / 112 |

All four burners ran throughout the measurement with a 1.5-CPU quota, 256 shares and a 1,536 MiB memory limit each. Forty-six host CPU samples from 09:06:50 to the end averaged 99.98% busy (minimum 99.92%, from Linux CPU accounting). The busy loops used little RAM. The first 37 seconds of the pre-load baseline overlapped the tail of the repository checks. All those checks finished before the burners started. The full-session snapshot had the highest late-load p95, 194 ms. Each snapshot reads the session's accumulated timeline.

**Logs:** zero engine or server error lines during load, zero matches for the UPS buffer, late heartbeat or lease-fencing messages, and zero container restarts. Four engine warnings in recovery and one during teardown reported that an actor WebSocket tunnel stopped. The server had no warning or error lines in the load-test log window.

The supplied real-agent Cloud reference measured idle p50/p95 of 41/84 ms and late-load p50/p95/max of 261/8,300/14,500 ms, with nine failures and an engine restart. This run used loopback requests, a scripted ACP stream and CPU-only burners. Production network latency, model behavior, agent memory pressure and workspace disk I/O were outside the measurement.

## Final restore and handoff

The load run preceded two validation changes: the server now rejects credentials in a configured token endpoint, and temporary containers clear the Compose labels inherited from their image. The measurement used the same private endpoint, engine executable, repository actors, fake ACP workload, quotas and CPU shares as the committed kit.

The server and engine images were built again and tagged `bf9db32`. The newly started server read the loaded session. A second S3-compatible backup was then restored to a new, isolated volume. The stop, tar copy and container start took 17 seconds. The gzip archive was 17,606,117 bytes. A lookup through the restored user actor and a snapshot through the restored session actor reproduced all **3,954 timeline items**, SHA-256 `49974fa911cf90ceb4b0160a7577bde58349e2a1d1e6452ff656cc40ad26c00e`.

```sh
deploy/selfhost/backup.sh .data/selfhost/staging.env
deploy/selfhost/restore.sh .data/selfhost/staging.env "$(cat .data/selfhost/final-archive.out)"
server/node_modules/.bin/tsx scripts/selfhost-load.ts \
  --origin http://127.0.0.1:18440 --project wlp-restore-check \
  --verify .data/selfhost/load-proof.json
```

Trimmed output from the final drill:

```text
Stop, volume copy and start took 17 s
Retention kept the newest snapshot and the unrelated object.
Restored user lists the session; verified timeline items: 3954 sha256: 49974fa911cf90ceb4b0160a7577bde58349e2a1d1e6452ff656cc40ad26c00e
```

Staging is on its original volume, `wlp-staging_engine-data`. The drill containers, restored volumes, CPU burners and local S3 test service were removed. The mode-600 stack env, final proof and archives are in the git-ignored `.data/selfhost/` directory. The final archive's basename is in `.data/selfhost/final-archive.out`. Public tunnel routing and a remote bucket were outside the drill.

## Repository checks

```sh
(cd web && npx tsx ../scripts/web-stage-check.ts)
WLP_DEMO=1 WLP_SANDBOX=fake pnpm test
pnpm typecheck
pnpm --filter @windlass-platform/server exec tsx ../scripts/runner-e2e.ts
# In a shell with the private staging admin token exported:
WLP_CHECK_ENGINE=http://127.0.0.1:16420 pnpm --filter @windlass-platform/server exec tsx ../scripts/connection-check.ts
```

On the committed implementation the web-stage check found all 19 bundled files, all three workspace typechecks passed, and the repository test command reported:

```text
Test Files  33 passed (33)
Tests       570 passed (570)
ALL PASSED: 146 passed, 0 failed, 1 skipped (sandbox layer: fake)
```

The skip covers cloning a real repository in the fake layer. The runner end-to-end check passed 62 checks and the connection check passed all 58, including real token expiry against the local engine.
