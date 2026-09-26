import { createHash } from "node:crypto";
import type { SandboxImage } from "@app/lib/api/sandbox/image/sandbox_image";
import type { Operation } from "@app/lib/api/sandbox/image/types";

const RECEIPT_PATH = "/etc/dust/preinstalled-dependencies.sha256";
// E2B infra fc9bc5b616cc41d706517ffac8ec50a6a145ae64, Debian distro profile.
// Provisioning checks these before running Dust's image operations.
const PROVISION_PACKAGES = [
  "systemd",
  "systemd-sysv",
  "openssh-server",
  "sudo",
  "chrony",
  "socat",
  "curl",
  "ca-certificates",
  "fuse3",
  "iptables",
  "git",
  "nfs-common",
  "less",
  "nftables",
  "iputils-ping",
  "jq",
  "iproute2",
];

function dependencyCommands(image: SandboxImage): string[] {
  return image.operations.flatMap((op) => {
    if (op.type !== "run" || !op.preinstall) {
      return [];
    }
    if (op.user && op.user !== "root") {
      throw new Error(
        "Preinstalled dependencies must support installation as root"
      );
    }
    return [op.command];
  });
}

export function dependencyRecipeSha256(image: SandboxImage): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        base: image.baseImage.imageRef,
        packages: PROVISION_PACKAGES,
        commands: dependencyCommands(image),
      })
    )
    .digest("hex");
}

export function requireImmutableImage(imageRef: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(imageRef)) {
    throw new Error(
      "The preinstalled/base image must be pinned by sha256 digest"
    );
  }
}

/**
 * @cc [owner:jchen0824,label:security;cli] offline-dependency-build
 * Export only explicitly marked dependency installs, in recipe order, into an
 * immutable-base OCI build. All installs run as root with Dust's shared runtime
 * environment. Account, SSH, service and path hardening must remain E2B steps.
 */
export function dependencyDockerfile(
  image: SandboxImage,
  baseImage: string
): string {
  requireImmutableImage(baseImage);
  const commands = dependencyCommands(image);
  if (commands.length === 0) {
    throw new Error("The image has no preinstallable dependency operations");
  }
  const run = (command: string) =>
    `RUN ${JSON.stringify([
      "/bin/bash",
      "-lc",
      `set -e; source /etc/profile.d/dust-env.sh; ${command}`,
    ])}`;
  return [
    `FROM ${baseImage}`,
    "USER root",
    "ENV DEBIAN_FRONTEND=noninteractive",
    run(
      `apt-get update && apt-get install -y --no-install-recommends ${PROVISION_PACKAGES.join(" ")}`
    ),
    ...commands.map(run),
    run(
      `mkdir -p /etc/dust && printf '%s\\n' '${dependencyRecipeSha256(image)}' > ${RECEIPT_PATH} && chmod 644 ${RECEIPT_PATH}`
    ),
    "",
  ].join("\n");
}

/**
 * @cc [owner:jchen0824,label:security;cli] verify-before-skipping-installs
 * An offline template must verify its embedded dependency recipe receipt before
 * skipping marked installs. Preserve every other operation in its original order.
 */
export function offlineImageOperations(
  image: SandboxImage
): readonly Operation[] {
  return [
    {
      type: "run",
      user: "root",
      command: `test "$(/usr/bin/cat ${RECEIPT_PATH})" = '${dependencyRecipeSha256(image)}'`,
    },
    ...image.operations.filter((op) => op.type !== "run" || !op.preinstall),
  ];
}
