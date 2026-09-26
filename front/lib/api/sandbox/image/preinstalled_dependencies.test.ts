import {
  dependencyDockerfile,
  dependencyRecipeSha256,
  offlineImageOperations,
} from "@app/lib/api/sandbox/image/preinstalled_dependencies";
import { SandboxImage } from "@app/lib/api/sandbox/image/sandbox_image";
import { describe, expect, it } from "vitest";

const BASE = `registry.example/dust/bedrock@sha256:${"a".repeat(64)}`;

function fixture() {
  return SandboxImage.fromDocker("bedrock:1")
    .setUser("agent")
    .runCmd("lock-accounts", { user: "root" })
    .runCmd("install-python", { user: "root", preinstall: true })
    .copy(() => "private service config", "/etc/service.conf", { user: "root" })
    .registerTool(
      { name: "tool", description: "tool", runtime: "node" },
      {
        installCmd: "install-node-tools",
        preinstall: true,
      }
    )
    .runCmd("harden-paths", { user: "root" });
}

describe("offline dependency image", () => {
  it("keeps configuration and hardening in E2B, preserving normal build order", () => {
    const image = fixture();
    const original = [...image.operations];
    const dockerfile = dependencyDockerfile(image, BASE);
    expect(dockerfile.indexOf("install-python")).toBeLessThan(
      dockerfile.indexOf("install-node-tools")
    );
    expect(dockerfile).not.toContain("lock-accounts");
    expect(dockerfile).not.toContain("harden-paths");
    expect(dockerfile).not.toContain("private service config");
    const offline = offlineImageOperations(image);
    expect(offline.slice(1)).toEqual([
      original[0],
      original[1],
      original[3],
      original[5],
    ]);
    expect(image.operations).toEqual(original);
    expect(offline[0]).toEqual(
      expect.objectContaining({
        type: "run",
        user: "root",
        command: expect.stringContaining(dependencyRecipeSha256(image)),
      })
    );
  });

  it("invalidates the embedded receipt when dependency commands or logical base change", () => {
    const image = fixture();
    const changed = image.runCmd("install-new-dependency", {
      preinstall: true,
    });
    expect(dependencyRecipeSha256(changed)).not.toBe(
      dependencyRecipeSha256(image)
    );
    expect(
      dependencyRecipeSha256(SandboxImage.fromDocker("bedrock:2"))
    ).not.toBe(dependencyRecipeSha256(SandboxImage.fromDocker("bedrock:1")));
    expect(dependencyDockerfile(image, BASE)).toContain(
      dependencyRecipeSha256(image)
    );
  });

  it("rejects mutable images, empty recipes and account-dependent installs", () => {
    expect(() => dependencyDockerfile(fixture(), "bedrock:latest")).toThrow(
      "sha256"
    );
    expect(() =>
      dependencyDockerfile(SandboxImage.fromDocker("bedrock:1"), BASE)
    ).toThrow("no preinstallable");
    expect(() =>
      dependencyDockerfile(
        fixture().runCmd("install", { user: "agent", preinstall: true }),
        BASE
      )
    ).toThrow("as root");
  });

  it("serializes shell commands as one Docker RUN argument without Dockerfile injection", () => {
    const command = "printf 'a\\nb'\n# a shell comment\nprintf '%s' \"$HOME\"";
    const image = SandboxImage.fromDocker("bedrock:1").runCmd(command, {
      preinstall: true,
    });
    const lines = dependencyDockerfile(image, BASE).split("\n");
    const runs = lines.filter((line) => line.startsWith("RUN "));
    const parsed = runs.map((line) => JSON.parse(line.slice(4)));
    expect(parsed[1]).toEqual([
      "/bin/bash",
      "-lc",
      `set -e; source /etc/profile.d/dust-env.sh; ${command}`,
    ]);
  });
});
