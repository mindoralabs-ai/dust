# Mindora Dust image bootstrap

This bootstrap is pinned to upstream Dust commit
`2036fc2ff982bf1385e252e9fa3d430d9c05379e`. The Mindora patch commit is a
separate receipt field so a build can prove both the reviewed upstream input and
the exact patched tree. This repository does not currently contain an approved
registry, Workload Identity provider, or publishing principal. The Mindora
workflow therefore builds Linux amd64 images and uploads local build evidence;
it never authenticates or publishes.

## Dust-built roles

`docs/mindora/image-contract.json` is the source of truth for the build matrix.
It enables these roles:

| Role | Dockerfile target | Runtime command | Migration command |
|---|---|---|---|
| `front_api` | `dockerfiles/front.Dockerfile` / `front-api` | `node --enable-source-maps --require dd-trace/init dist/server.js` | front pre-deploy before rollout; run post-deploy separately as described below |
| `front_spa` | `dockerfiles/front-spa.Dockerfile` / `front-spa` | nginx on port 8080 | none |
| `front_workers` | `dockerfiles/front.Dockerfile` / `workers` | command below | none |
| `core_api` | `dockerfiles/core.Dockerfile` / `core` | `core-api` | none recorded |
| `sqlite_worker` | `dockerfiles/core.Dockerfile` / `core` | `sqlite-worker` | none recorded |
| `viz_renderer` | `dockerfiles/viz.Dockerfile` / `viz` | `npm --silent run start` | none |
| `egress_proxy` | `dockerfiles/egress-proxy.Dockerfile` / `egress-proxy` | `cargo run --release --bin egress-proxy` | none |
| `connectors_api` | `dockerfiles/connectors.Dockerfile` / `connectors` | `node dist/start_server.js -p 3002` | connectors pre-deploy before rollout, as described below |
| `connectors_workers` | `dockerfiles/connectors.Dockerfile` / `connectors` | `node dist/start_worker.js --workers dust_project` | none |

Core API and SQLite worker intentionally share one image and select different
commands at deployment. The connectors API and the connectors workers also share
one image. Frame sandbox state is persistent state mounted into a
sandbox, not another Dust-built service image. E2B and the Temporal, Redis,
Qdrant, and Elasticsearch images are separate qualification inputs and are not
silently substituted by this build.

### Initialize a fresh Core database

The shared Core image includes Dust's existing `init_db` binary. Run it once,
explicitly, against a fresh, dedicated PostgreSQL database before starting the
Core API or SQLite worker:

```sh
docker run --rm \
  -e CORE_DATABASE_URI \
  '<core-image>@sha256:<registry-digest>' \
  sh -ec ': "${CORE_DATABASE_URI:?CORE_DATABASE_URI is required}"; exec init_db'
```

Provide `CORE_DATABASE_URI` to the invoking environment through the deployment's
secret-aware mechanism; do not put database credentials directly on the command
line. For this POC, do not set `OAUTH_DATABASE_URI`; the OAuth schema is outside
the selected runtime scope. The command is an operator-controlled bootstrap
step. The image does not run it automatically at startup, and the normal
`core-api` entry point remains unchanged.

SQL files under `core/src/stores/migrations/` and executables under
`core/bin/migrations/` are historic, one-off data or schema deltas. They are not
an ordered migration chain and must not be replayed as database bootstrap. The
database-store used by the selected POC remains GCS-backed; it does not require
a separate PostgreSQL initializer.

### Run Front migrations around the rollout

Run the Front migration phases as separate lifecycle steps. Before deploying a
new Front release, run:

```sh
node ../scripts/db/run-migrate.cjs --command pre-deploy --execute
```

Deploy the new Front API and worker images, wait until every old API and worker
pod has been replaced, and only then run:

```sh
node ../scripts/db/run-migrate.cjs --command post-deploy --execute
```

Use the same order for a fresh installation: pre-deploy migrations, the complete
Front API and worker rollout, then post-deploy migrations. Never combine the two
migration commands into one bootstrap job because post-deploy migrations may
remove schema that old pods still require.

The front worker deployment must override the image default, which starts
almost every registered worker. The following is the earlier application-flow candidate:

```text
node --enable-source-maps --require dd-trace/init dist/start_worker.js --workers agent_loop_interactive agent_loop_programmatic agent_loop_schedules agent_schedule sandbox_reaper remote_tools_sync upsert_queue upsert_table_queue
```

This candidate excludes billing/credit alerts, WorkOS events, email/notification and
invitation paths, retention, labs, poke, and other maintenance groups. Under the
2026-09-12 WorkOS-first decision, it is **not a qualified complete worker list**.
Audit native WorkOS login, provisioning, organization membership and revocation
paths and include any required event queues before deployment. Qualify the
invitation/authentication email paths actually used; disabling all auth-related
workers or notifications is no longer an accepted blanket POC assumption.

The capability POC retains hosted WorkOS authentication and native Dust permissions.
Configure its callbacks, secrets and controlled tester memberships; record stable
Mindora employee/Dust user/WorkOS user and tenant/workspace/organization mappings.
Custom Mindora login and automatic Mindora-to-Dust revocation move to the later
identity migration. Operators manage POC Dust access separately. The external
MCP opt-out in the runtime PR does not disable employee login.

This packaging PR creates images; it does not prove the selected WorkOS environment,
worker queues, session revocation or full runtime have been configured or tested.

### Run the connectors API and workers

Both connectors roles run from `/app/connectors` in the connectors image with
`NODE_ENV=production`. Provide credentials and secrets through the deployment's
secret-aware mechanism, never on the command line. `TEMPORAL_*` below means
`TEMPORAL_ADDRESS`, `TEMPORAL_TLS_MODE`, `TEMPORAL_NAMESPACE` and any certificate
settings that the selected TLS mode needs, as described in
[temporal.md](temporal.md).

| Role | Command | Probe | Required environment |
|---|---|---|---|
| `connectors_api` | `node dist/start_server.js -p 3002` | `GET /` on port 3002 | `CONNECTORS_DATABASE_URI`, `DUST_CONNECTORS_SECRET`, `DUST_CONNECTORS_WEBHOOKS_SECRET`, `CONNECTORS_ENABLED_PROVIDERS=dust_project`, `TEMPORAL_*` |
| `connectors_workers` | `node dist/start_worker.js --workers dust_project` | `GET /readyz` on `127.0.0.1:$WORKER_HEALTH_PORT` | `CONNECTORS_DATABASE_URI`, `DUST_FRONT_API`, `CONNECTORS_ENABLED_PROVIDERS=dust_project`, `TEMPORAL_*`, `WORKER_HEALTH_PORT` |

The API's `GET /` returns 200 without authentication. It shows only that the HTTP
server is listening, not that the database or Temporal is reachable. Set
`CONNECTORS_ENABLED_PROVIDERS=dust_project` so the API refuses connectors whose
workers this deployment does not run. Give the workers the same value: a workflow
the API starts can reach another connector than the one the API checked, such as a
Slack team's active bot, and the worker checks that connector against its own
value.

The worker command must keep `--workers dust_project`. Without `--workers`, the
process starts every registered connectors worker. An empty or duplicated
`--workers` list fails startup. If a worker throws, or stops before the process
receives SIGTERM or SIGINT, the process logs `Error running <worker> worker.` and
exits with code 1, so the orchestrator restarts it.

The worker opens its health listener only when `WORKER_HEALTH_PORT` is set, and an
invalid port fails startup. The listener binds to `127.0.0.1`, so the readiness
probe must run inside the container, for example as an exec probe:

```sh
node -e 'fetch(`http://127.0.0.1:${process.env.WORKER_HEALTH_PORT}/readyz`).then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))'
```

`/readyz` returns 200 only after the `dust_project` Temporal worker is `RUNNING`.
It returns 503 while the worker connects or starts, after SIGTERM or SIGINT, and
whenever the worker drains, stops or fails. Only `dust_project` reports its
Temporal worker state, so readiness stays 503 if any other worker is selected.

### Run connectors migrations around the rollout

The connectors image contains the shared migration runner and `psql`, which runs
the SQL files. Before deploying a new connectors API and worker release, and
before the first start on a fresh database, run from `/app/connectors` with
`CONNECTORS_DATABASE_URI` and `NODE_ENV=production`:

```sh
node ../scripts/db/run-migrate.cjs --command pre-deploy --execute
```

This runs `node dist/migrate.js --command pre-deploy --execute`. On a fresh
database, the first pre-deploy migration creates the connectors schema. After
every old connectors API and worker pod has been replaced, run the same command
with `--command post-deploy`. As with Front, never combine the two phases into
one job.

## Deterministic inputs and local builds

The front image generator accepts `front/custom-models.json`. For this POC the
input is exactly `{"models":[]}` and no custom model ID is enabled. If that file
is absent, the upstream script tries private GCS before falling back; local and
CI builds should create the empty input in the build context so they never make
that private lookup. Provider IDs and model defaults are unchanged. The Rust
Dockerfiles default `CARGO_BUILD_JOBS` to `2` to keep core and egress
compilation within the local 8 GiB qualification host.

Build a role without publishing:

```sh
docker build --platform linux/amd64 \
  --target front-api \
  --build-arg COMMIT_HASH="$(git rev-parse --short=8 HEAD)" \
  --build-arg COMMIT_HASH_LONG="$(git rev-parse HEAD)" \
  --build-arg NEXT_PUBLIC_DUST_APP_URL=http://localhost:8080 \
  -f dockerfiles/front.Dockerfile \
  -t "mindora-dust-front-api:$(git rev-parse HEAD)" .
```

The SPA inlines its origins at build time. `dockerfiles/front-spa.Dockerfile` needs the
`NEXT_PUBLIC_DUST_API_URL`, `NEXT_PUBLIC_DUST_APP_URL` and
`NEXT_PUBLIC_DUST_STATIC_WEBSITE_URL` build arguments, or pages that link to the website crash.

The CI workflow verifies that its checkout equals `GITHUB_SHA` and that the
pinned Dust source is an ancestor before building. Runtime commit metadata uses
that actual patched `GITHUB_SHA`; `DUST_SOURCE_SHA` remains separate upstream
source evidence. Identical Dockerfile/target pairs build once, so core API and
SQLite worker share one build while receiving separate role evidence. Pull
requests build automatically; `workflow_dispatch` supports an explicit rerun
without duplicating the same work on every branch push. The workflow records
the local image ID as build evidence. A Docker image ID is not a registry
manifest digest and must never be copied into a deployment receipt.

## Publication receipts

After an approved registry target path exists, every enabled role needs exactly
one JSON receipt with these fields:

```json
{
  "source_sha": "2036fc2ff982bf1385e252e9fa3d430d9c05379e",
  "patch_sha": "<exact 40-character patched Git SHA>",
  "role": "front_api",
  "dockerfile": "dockerfiles/front.Dockerfile",
  "target": "front-api",
  "digest": "sha256:<64 lowercase hex characters>",
  "migration_command": "node ../scripts/db/run-migrate.cjs --command pre-deploy --execute"
}
```

Validate a complete receipt array before deployment consumes it:

```sh
python3 tools/mindora/verify-image-contract.py \
  docs/mindora/image-contract.json receipts.json "$EXPECTED_PATCH_SHA"
```

`EXPECTED_PATCH_SHA` is the reviewed 40-character commit that publication built.
The verifier requires every receipt to match it and rejects unknown, missing, or
duplicate roles, mutable tags, source or patch SHA errors, and Dockerfile,
target, or migration drift. It does not
publish, inspect a registry, or prove that an entry point can connect to its
dependencies.

## Current gate

B2 remains incomplete until every selected role builds from the patched tree,
is published to an approved immutable target, has a real registry digest, and
has its configured entry point checked in a disposable dependency environment.
The deployment manifest must remain incomplete until those receipts exist.
Identity integration, E2B qualification, storage, probes, and live runtime
acceptance are later gates.
