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
Qdrant, Elasticsearch, and Apache Tika images are separate qualification inputs
and are not silently substituted by this build.

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

### Configure direct provider mode

The POC serves one Dust workspace in direct provider mode: Front and Core call
Vertex AI for that workspace without the signed tenant registry or CRM
admission. Provide secrets through the deployment's secret-aware mechanism,
never on the command line.

| Role | Required environment |
|---|---|
| `front_api`, `front_workers` | `DUST_POC_MODE=1`, `DUST_POC_DIRECT_PROVIDER_MODE=1`, `DUST_POC_DIRECT_WORKSPACE_ID`, `DUST_POC_DIRECT_DAILY_TOKEN_LIMIT`, `DUST_FRONT_VERTEX_PROVIDER_IO_ENABLED=1`, `DUST_FRONT_VERTEX_EMBEDDING_SELECTION_ENABLED=1`, `DUST_CORE_WORKSPACE_ASSERTION_SECRET`, `TEXT_EXTRACTION_URL` |
| `core_api` | `DUST_POC_MODE=1`, `DUST_CORE_VERTEX_PROVIDER_IO_ENABLED=1`, `DUST_POC_DIRECT_PROVIDER_MODE=1`, `DUST_POC_DIRECT_WORKSPACE_ID`, `DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT`, `DUST_CORE_USAGE_JOURNAL_PATH`, `DUST_CORE_WORKSPACE_ASSERTION_SECRET`, `VERTEX_AI_PROJECT_ID`, `VERTEX_AI_LOCATION=global` |

`DUST_POC_DIRECT_WORKSPACE_ID` is the served workspace's sId: 1 to 128 letters,
digits, `-` or `_`. Front and Core need the same value. While it is malformed,
Front refuses every generation and every Pod or data source creation.

`DUST_FRONT_VERTEX_PROVIDER_IO_ENABLED=1` arms Front's generation provider
switch. `DUST_POC_DIRECT_DAILY_TOKEN_LIMIT` caps the workspace's generation
input and output tokens per UTC day. Each unsettled attempt reserves 64,000
tokens, so Front refuses every generation when the limit is below 64,000.

`DUST_FRONT_VERTEX_EMBEDDING_SELECTION_ENABLED=1` makes the workspace's new Pods
and data sources embed with Vertex. Only a workspace member's own request
selects Vertex. If the switch is unset or `0`, or the caller is an internal
admin or a non-member, creating one in that workspace fails before Core creates
a project. An operator can still repair a Pod whose Core data source exists.
Other workspaces keep their embedding provider.

Creating a Vertex Pod or data source, or relocating a Vertex data source and its
documents to another region, needs no OpenAI embedding key. On a strict BYOK
plan, one that is not `FREE_BYOK_TRANSITIONING` and lacks the `use_dust_keys`
flag, any other document upsert or search does need one, even in a Vertex data
source: the workspace must have an OpenAI key in its provider settings, which
Front sends as `OPENAI_EMBEDDING_API_KEY`. Non-BYOK plans never need one.

`DUST_CORE_WORKSPACE_ASSERTION_SECRET` must have the same value, at least 32
characters, on Front and Core. Front signs its Core search and upsert requests
with it, and Core refuses Vertex embedding without a valid assertion.

`DUST_CORE_DIRECT_EMBEDDING_DAILY_TOKEN_LIMIT` is Core's daily Vertex embedding
token limit for the workspace, per UTC day: plain digits, from 8,192 to
1,000,000,000. Core counts the input tokens Vertex reports for settled requests,
plus 8,192 tokens for each request not yet settled, which is
`gemini-embedding-2`'s input limit. A request that would exceed the limit is
refused with `429 quota_exceeded` before any token or Vertex request. It is a
separate budget from Front's generation limit. `DUST_CORE_USAGE_JOURNAL_PATH`
is an absolute path on a volume retained across restarts and rollouts: Core
journals each embedding request there and counts the daily limit from that
journal, so run one Core replica on that volume. Leave
`DUST_CORE_REGISTRY_SIGNER_URL` unset: Core's signed usage reconciler then stays
off. `VERTEX_AI_PROJECT_ID` is the project Core calls Vertex in, with
credentials from the pod's Workload Identity.

Front's direct mode reads neither `DUST_POC_WORKSPACE_IDS` nor the
`DUST_FRONT_REGISTRY_*` signer settings. Leave `DUST_FRONT_REGISTRY_SIGNER_URL`
unset: when it is set, the Front workers also reconcile signed usage, which
needs the complete signed registry configuration.

`TEXT_EXTRACTION_URL` is the base URL of the POC's Tika server, described with
the connectors workers below. Front sends uploaded documents to it to extract
their text, with OCR.

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
| `connectors_workers` | `node dist/start_worker.js --workers dust_project` | `GET /readyz` on `127.0.0.1:$WORKER_HEALTH_PORT` | `CONNECTORS_DATABASE_URI`, `DUST_FRONT_API`, `TEXT_EXTRACTION_URL`, `CONNECTORS_ENABLED_PROVIDERS=dust_project`, `TEMPORAL_*`, `WORKER_HEALTH_PORT` |

The API's `GET /` returns 200 without authentication. It shows only that the HTTP
server is listening, not that the database or Temporal is reachable. Set
`CONNECTORS_ENABLED_PROVIDERS=dust_project` so the API refuses connectors whose
workers this deployment does not run. Give the workers the same value: a workflow
the API starts can reach another connector than the one the API checked, such as a
Slack team's active bot, and the worker checks that connector against its own
value.

`TEXT_EXTRACTION_URL` is the base URL of an Apache Tika server. The worker sends
the PDF, Word and PowerPoint files of a project mount to its `/tika` endpoints to
extract their text; it skips spreadsheets. The connectors image does not include
Tika. The POC runs an internal Apache Tika 3.2.3 server from the `-full` image,
`apache/tika:3.2.3.0-full`, with the repository's `tika-config.xml`, as
upstream's local stack in `docker-compose.yml` does on port 9998. Set the
variable to that server's base URL:

- When it is unset, the worker still starts and `/readyz` returns 200, but the
  first such file makes the mount-file sync activity throw. Temporal retries that
  activity without limit, so the project's sync never completes.
- When no Tika server answers at its URL, the worker skips each such file with a
  warning after three attempts. Those files are not indexed, and the rest of the
  project syncs.

`slack` and `slack_bot` share the `slack` worker, its workflows and activities, and
much other code, so `CONNECTORS_ENABLED_PROVIDERS` must enable both or neither.
`PROVIDER_GROUPS` in `connectors/src/lib/enabled_connector_providers.ts` lists the
providers that must be enabled together. A list that enables only some providers
of a group is malformed: the API refuses to start and the worker process refuses
to start any worker.

When `CONNECTORS_ENABLED_PROVIDERS` is set, the worker process checks it before
starting any worker. If the value is malformed, or does not enable every provider
that a selected worker does work for, the process logs `Error running workers` and
exits with code 1. `WORKER_PROVIDERS` in `connectors/src/temporal/worker_registry.ts`
lists the providers of each worker.

The worker command must keep `--workers dust_project`. Without `--workers`, the
process selects every registered connectors worker, which
`CONNECTORS_ENABLED_PROVIDERS=dust_project` refuses. An empty or duplicated
`--workers` list fails startup. If a worker throws, or stops before the process
receives SIGINT, SIGTERM, SIGQUIT or SIGUSR2, the process logs
`Error running <worker> worker.` and exits with code 1, so the orchestrator
restarts it.

Temporal's runtime shuts the workers down on exactly those four signals. On any of
them, the process only marks itself as shutting down, so `/readyz` returns 503, and
leaves the shutdown to the runtime. The runtime drains every
running Temporal worker and also shuts down a worker that finishes starting after
the signal. The process exits after the workers stop. If connecting to Temporal or
creating a worker hangs, the process keeps running until the orchestrator sends
SIGKILL at the end of the pod's `terminationGracePeriodSeconds`.

The worker opens its health listener only when `WORKER_HEALTH_PORT` is set, and an
invalid port fails startup. The listener binds to `127.0.0.1`, so the readiness
probe must run inside the container, for example as an exec probe:

```sh
node -e 'fetch(`http://127.0.0.1:${process.env.WORKER_HEALTH_PORT}/readyz`).then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))'
```

`/readyz` returns 200 only after the `dust_project` Temporal worker is `RUNNING`.
It returns 503 while the worker connects or starts, after any of those four
signals, and whenever the worker drains, stops or fails. Only `dust_project` reports its
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
