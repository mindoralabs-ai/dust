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

Core API and SQLite worker intentionally share one image and select different
commands at deployment. Frame sandbox state is persistent state mounted into a
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
