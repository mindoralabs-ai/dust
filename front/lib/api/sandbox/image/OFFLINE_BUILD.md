# Building dependencies outside an offline E2B cluster

The self-hosted POC denies guest-initiated network traffic, including template
builds. Use the same Dust image recipe in two stages: download/install dependencies
in a trusted OCI builder, then import that image and finish configuration in E2B.
The ordinary E2B build path is unchanged unless `--preinstalled-image` is supplied.

From `front`, export a context using the selected bedrock image's immutable digest:

```sh
npx tsx scripts/sandbox_image_dependencies.ts \
  --image dust-base \
  --base-image REGISTRY/dust-sbx-bedrock@sha256:BEDROCK_DIGEST \
  --output /tmp/dust-dependencies
```

Build and publish that context with the dedicated build identity. Record the source
commit, bedrock digest, Dockerfile checksum, build result and resulting OCI digest.
The generated Dockerfile installs E2B's Debian provisioning packages, then only
recipe operations explicitly marked `preinstall`. It runs them as root using
`/etc/profile.d/dust-env.sh`; marked commands must install shared dependencies and
must not depend on earlier account creation, copies, workdir or environment steps.
The package list is qualified against the E2B source revision recorded in
`preinstalled_dependencies.ts`; requalify it when upgrading E2B.

Import the resulting digest through the self-hosted builder's registry identity:

```sh
npx tsx scripts/sandbox_image_build.ts \
  --image dust-base --tag 0.8.111 \
  --preinstalled-image REGISTRY/dust-base-dependencies@sha256:DEPENDENCY_DIGEST \
  --preinstalled-base-image REGISTRY/dust-sbx-bedrock@sha256:BEDROCK_DIGEST
```

Use the existing `SBX_DEV_IMAGE_SUFFIX` for candidate builds. Only the reviewed
release build should use `--release`. Credentials stay in the normal operator
secret environment. The E2B SDK supports `E2B_API_URL` for a private operator tunnel;
no service-account JSON key is uploaded by the preinstalled-image path. Registry
access must already be configured on the self-hosted E2B host.

The OCI image carries a checksum binding the dependency recipe and selected bedrock
digest. Pass that same expected base digest during import. E2B verifies it before
skipping any install, so a changed recipe rejects a stale image. This is a
consistency check, not image authentication: the trusted build receipt and pinned
digest are still required. E2B retains all unmarked operations in order, including
user setup, copied tools/assets, service configuration and Dust hardening. The
import path normalizes only `/` to root:root mode 0755; a private host directory
mode must not prevent non-root workloads from traversing the guest filesystem.
Descendant permissions are retained. Do not
remove or mark those operations as preinstallable to make a build pass.

The dependency OCI image is not a finished Dust sandbox and intentionally contains
E2B provisioning dependencies such as sudo. E2B provisioning can also reset local
account/path state; Dust's existing create-time hardening remains mandatory before
untrusted execution. Acceptance requires the completed template, a real Dust
sandbox, runtime hardening and network-isolation tests. A successful OCI build or
an E2B template listed without a successful build is insufficient.

For the bounded POC profile, use `DUST_POC_MODE=1`,
`DUST_POC_SANDBOX_NETWORK_PROFILE=dust-poc` and
`NEXT_PUBLIC_DUST_API_URL=https://dust-api-sit.oktocrew.ai` for both the template
build and the running Front API/workers. Build the new `0.8.111` release alias;
`0.8.110` templates do not contain the required hostname mappings. After deployment,
use `/poke/kill` to retire older versions if any exist, and verify that new app
invocations use the newly qualified template ID. Do not force-replace the old
alias or treat image-list presence as build compatibility proof.
