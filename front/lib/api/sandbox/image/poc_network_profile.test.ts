import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let directory: string;
beforeEach(() => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), "dust-network-profile-"));
  const certPath = join(directory, "ca.crt");
  const result = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    join(directory, "ca.key"),
    "-out",
    certPath,
    "-subj",
    "/CN=Dust test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  ]);
  expect(result.status).toBe(0);
  vi.stubEnv("DUST_POC_MODE", "1");
  vi.stubEnv("DUST_POC_EGRESS_CA_CERT_PATH", certPath);
  vi.stubEnv("DUST_POC_SANDBOX_NETWORK_PROFILE", "dust-poc");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function registeredImage() {
  const { getSandboxImageFromRegistry } = await import("./registry");
  const image = getSandboxImageFromRegistry({ name: "dust-base" });
  if (image.isErr()) {
    throw image.error;
  }
  return image.value;
}

describe("bounded POC sandbox network profile", () => {
  test("uses the same exact CIDRs for registered templates and runtime creates", async () => {
    const image = await registeredImage();
    expect(image.toCreateConfig().network).toEqual({
      mode: "deny_all",
      allowlist: ["199.36.153.4/30", "136.69.9.46/32", "192.168.242.7/32"],
    });
  });

  test("keeps hosts setup in offline E2B steps rather than OCI dependencies", async () => {
    const image = await registeredImage();
    const { offlineImageOperations } = await import(
      "./preinstalled_dependencies"
    );
    const operations = offlineImageOperations(
      image,
      `example.com/base@sha256:${"a".repeat(64)}`
    );
    const hostsStep = operations.find(
      (operation) =>
        operation.type === "run" && operation.command.includes("/etc/hosts")
    );
    expect(hostsStep).toMatchObject({ type: "run", user: "root" });
    expect(hostsStep).not.toHaveProperty("preinstall");
  });

  test.each([
    "",
    "unknown",
    "allow_all",
  ])("rejects invalid profile %j", async (profile) => {
    vi.stubEnv("DUST_POC_SANDBOX_NETWORK_PROFILE", profile);
    await expect(registeredImage()).rejects.toThrow("sandbox network profile");
  });

  test("requires explicit POC mode", async () => {
    vi.stubEnv("DUST_POC_MODE", "0");
    await expect(registeredImage()).rejects.toThrow("sandbox network profile");
  });

  test("preserves upstream policy when not opted in", async () => {
    vi.stubEnv("DUST_POC_SANDBOX_NETWORK_PROFILE", undefined);
    const image = await registeredImage();
    const { PROXY_ONLY_NETWORK_POLICY } = await import("./types");
    expect(image.network).toEqual(PROXY_ONLY_NETWORK_POLICY);
  });

  test("does not let development settings widen the opted-in policy", async () => {
    vi.stubEnv("IS_DEVELOPMENT", "true");
    vi.stubEnv("SBX_DEV_UNRESTRICTED_EGRESS", "true");
    vi.stubEnv("SBX_DEV_FRONT_URL", "https://tunnel.example.com");
    vi.stubEnv("SBX_DEV_IMAGE_SUFFIX", "developer");
    const { getSandboxImage } = await import("./index");
    const image = getSandboxImage();
    if (image.isErr()) {
      throw image.error;
    }
    expect(image.value.toCreateConfig().network).toEqual({
      mode: "deny_all",
      allowlist: ["199.36.153.4/30", "136.69.9.46/32", "192.168.242.7/32"],
    });
    expect(image.value.imageId).toEqual((await registeredImage()).imageId);
  });
});
