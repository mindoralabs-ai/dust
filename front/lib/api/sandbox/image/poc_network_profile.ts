import config from "@app/lib/api/config";
import { dustPocMode } from "@app/lib/api/dust_poc_mode";
import type { SandboxImage } from "@app/lib/api/sandbox/image/sandbox_image";

/**
 * @cc [owner:jchen0824,label:security] explicit-poc-network-profile
 * Only an unset profile preserves upstream behavior. The dust-poc profile requires
 * POC mode; empty or unknown values must fail closed before template or VM creation.
 */
export function isPocSandboxNetworkProfile(): boolean {
  const profile = config.getDustPocSandboxNetworkProfile();
  if (profile === undefined) {
    return false;
  }
  if (profile !== "dust-poc" || !dustPocMode()) {
    throw new Error("Dust POC sandbox network profile is unavailable");
  }
  return true;
}

/**
 * @cc [owner:jchen0824,label:security] bounded-poc-image-network
 * An opted-in image must deny outbound traffic except the three fixed POC CIDRs.
 * Resolve GCS and the public Dust API through root-owned hosts records without
 * changing HTTPS names or allowing guest DNS. Hosts setup must remain an E2B
 * image step, never a preinstalled OCI dependency; the builder needs no egress.
 */
export function withPocSandboxNetwork(image: SandboxImage): SandboxImage {
  if (!isPocSandboxNetworkProfile()) {
    return image;
  }

  return image
    .withNetwork({
      mode: "deny_all",
      allowlist: ["199.36.153.4/30", "136.69.9.46/32", "192.168.242.7/32"],
    })
    .runCmd(
      [
        "test -f /etc/hosts && test ! -L /etc/hosts",
        // Refuse conflicting pre-existing records rather than silently selecting
        // an earlier mapping. The immutable template is built from a fresh base.
        "! grep -Eq '(^|[[:space:]])(storage\\.googleapis\\.com|dust-api-sit\\.oktocrew\\.ai)([[:space:]]|$)' /etc/hosts",
        "printf '\\n199.36.153.4 storage.googleapis.com\\n136.69.9.46 dust-api-sit.oktocrew.ai\\n' >> /etc/hosts",
        "chown root:root /etc/hosts && chmod 0644 /etc/hosts",
      ].join(" && "),
      { user: "root" }
    );
}
