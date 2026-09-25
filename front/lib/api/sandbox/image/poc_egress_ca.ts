import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import config from "@app/lib/api/config";
import { dustPocMode } from "@app/lib/api/dust_poc_mode";
import type { SandboxImage } from "@app/lib/api/sandbox/image/sandbox_image";

const CA_DESTINATION = "/usr/local/share/ca-certificates/dust-poc-egress.crt";

/**
 * @cc [owner:jchen0824,label:security;backend] poc-egress-proxy-ca
 * In POC mode, the template must trust exactly the configured public egress CA
 * before the sandbox forwarder starts. Reject missing, malformed, expired or
 * non-CA input and never copy a private key into a sandbox image.
 */
export function withPocEgressProxyCa(image: SandboxImage): SandboxImage {
  // The image registry is imported by ordinary Front tests and routes that mock
  // only the config methods they use. Avoid consulting POC config unless the
  // isolated instance actually requests this image extension.
  if (!process.env.DUST_POC_MODE || process.env.DUST_POC_MODE === "0") {
    return image;
  }
  if (!dustPocMode()) {
    return image;
  }

  const caPath = config.getDustPocEgressCaCertPath();
  if (!caPath || !isAbsolute(caPath)) {
    throw new Error("Dust POC egress CA is unavailable");
  }

  let pem: string;
  let certificate: X509Certificate;
  try {
    pem = readFileSync(caPath, "utf8");
    if (
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/.test(
        pem.trim()
      )
    ) {
      throw new Error("invalid CA bundle");
    }
    certificate = new X509Certificate(pem);
  } catch {
    throw new Error("Dust POC egress CA is unavailable");
  }

  const now = Date.now();
  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  if (
    !certificate.ca ||
    !Number.isFinite(notBefore) ||
    !Number.isFinite(notAfter) ||
    notBefore > now ||
    notAfter <= now
  ) {
    throw new Error("Dust POC egress CA is unavailable");
  }

  return image
    .copy(() => pem, CA_DESTINATION, { user: "root" })
    .runCmd(`chmod 644 ${CA_DESTINATION} && update-ca-certificates`, {
      user: "root",
    });
}
