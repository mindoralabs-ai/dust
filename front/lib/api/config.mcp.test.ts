import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_NAME = "DISABLE_EXTERNAL_MCP_SERVER";
const originalValue = process.env[ENV_NAME];

async function loadExternalMcpDisabledConfig() {
  const { default: config } = await import("./config");
  return config.isExternalMcpServerDisabled();
}

describe("isExternalMcpServerDisabled", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env[ENV_NAME];
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_NAME];
    } else {
      process.env[ENV_NAME] = originalValue;
    }
    vi.resetModules();
  });

  it("preserves external MCP by default", async () => {
    await expect(loadExternalMcpDisabledConfig()).resolves.toBe(false);
  });

  it("disables external MCP for the explicit true value", async () => {
    process.env[ENV_NAME] = "true";

    await expect(loadExternalMcpDisabledConfig()).resolves.toBe(true);
  });

  it("preserves external MCP for other values", async () => {
    process.env[ENV_NAME] = "false";

    await expect(loadExternalMcpDisabledConfig()).resolves.toBe(false);
  });
});
