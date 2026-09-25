import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxImage } from "@app/lib/api/sandbox/image/sandbox_image";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const temporaryDirectories: string[] = [];

beforeEach(() => vi.resetModules());

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeCa(): { certPath: string; keyPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "dust-poc-egress-ca-"));
  temporaryDirectories.push(directory);
  const certPath = join(directory, "ca.crt");
  const keyPath = join(directory, "ca.key");
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-subj",
      "/CN=Dust test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error("test CA generation failed");
  }
  return { certPath, keyPath };
}

describe("POC sandbox egress proxy trust", () => {
  test("preserves the upstream image outside POC mode", async () => {
    vi.stubEnv("DUST_POC_MODE", "0");
    const { withPocEgressProxyCa } = await import(
      "@app/lib/api/sandbox/image/poc_egress_ca"
    );
    const base = SandboxImage.fromDocker("ubuntu:24.04");
    expect(withPocEgressProxyCa(base)).toBe(base);
  });

  test("copies only a valid public CA and installs it in native roots", async () => {
    const { certPath } = makeCa();
    vi.stubEnv("DUST_POC_MODE", "1");
    vi.stubEnv("DUST_POC_EGRESS_CA_CERT_PATH", certPath);
    const { withPocEgressProxyCa } = await import(
      "@app/lib/api/sandbox/image/poc_egress_ca"
    );
    const image = withPocEgressProxyCa(SandboxImage.fromDocker("ubuntu:24.04"));
    const [copy, command] = image.operations;
    expect(copy).toMatchObject({
      type: "copy",
      dest: "/usr/local/share/ca-certificates/dust-poc-egress.crt",
      user: "root",
    });
    expect(copy?.type).toBe("copy");
    if (copy?.type !== "copy" || copy.src.type !== "content") {
      throw new Error("expected public CA content operation");
    }
    expect(copy.src.getContent()).toBe(readFileSync(certPath, "utf8"));
    expect(command).toMatchObject({
      type: "run",
      command:
        "chmod 644 /usr/local/share/ca-certificates/dust-poc-egress.crt && update-ca-certificates",
      user: "root",
    });
  });

  test("includes the CA in the registered POC sandbox image", async () => {
    const { certPath } = makeCa();
    vi.stubEnv("DUST_POC_MODE", "1");
    vi.stubEnv("DUST_POC_EGRESS_CA_CERT_PATH", certPath);
    const { getSandboxImageFromRegistry } = await import(
      "@app/lib/api/sandbox/image/registry"
    );
    const image = getSandboxImageFromRegistry({ name: "dust-base" });
    expect(image.isOk()).toBe(true);
    if (image.isErr()) {
      throw image.error;
    }
    expect(image.value.operations).toContainEqual(
      expect.objectContaining({
        type: "copy",
        dest: "/usr/local/share/ca-certificates/dust-poc-egress.crt",
      })
    );
  });

  test("rejects missing and private-key-bearing CA input", async () => {
    const { certPath, keyPath } = makeCa();
    vi.stubEnv("DUST_POC_MODE", "1");
    const { withPocEgressProxyCa } = await import(
      "@app/lib/api/sandbox/image/poc_egress_ca"
    );
    const base = SandboxImage.fromDocker("ubuntu:24.04");
    expect(() => withPocEgressProxyCa(base)).toThrow(
      "Dust POC egress CA is unavailable"
    );
    writeFileSync(
      certPath,
      readFileSync(certPath, "utf8") + readFileSync(keyPath, "utf8")
    );
    vi.stubEnv("DUST_POC_EGRESS_CA_CERT_PATH", certPath);
    expect(() => withPocEgressProxyCa(base)).toThrow(
      "Dust POC egress CA is unavailable"
    );
  });
});
