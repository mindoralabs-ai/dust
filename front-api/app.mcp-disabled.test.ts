import { afterAll, describe, expect, it, vi } from "vitest";

const externalMcpConfiguration = vi.hoisted(() => {
  process.env.DISABLE_EXTERNAL_MCP_SERVER = "true";
  return {
    getMcpResourceServerUrl: vi.fn(() => {
      throw new Error("external MCP resource URL must not be read");
    }),
    getWorkOSAuthKitDomain: vi.fn(() => {
      throw new Error("WorkOS AuthKit domain must not be read");
    }),
  };
});

vi.mock("@app/lib/api/mcp_server/urls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/lib/api/mcp_server/urls")>()),
  ...externalMcpConfiguration,
}));

import { honoApp } from "@front-api/app";

afterAll(() => {
  delete process.env.DISABLE_EXTERNAL_MCP_SERVER;
});

describe("external MCP server startup opt-out", () => {
  it("starts without external MCP configuration and leaves its routes unmounted", async () => {
    const responses = await Promise.all([
      honoApp.request("/mcp", { method: "POST" }),
      honoApp.request("/.well-known/oauth-protected-resource/mcp"),
      honoApp.request("/.well-known/oauth-protected-resource"),
      honoApp.request("/.well-known/oauth-authorization-server"),
      honoApp.request("/oauth2/token", { method: "POST" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404, 404, 404,
    ]);
    expect(
      externalMcpConfiguration.getMcpResourceServerUrl,
    ).not.toHaveBeenCalled();
    expect(
      externalMcpConfiguration.getWorkOSAuthKitDomain,
    ).not.toHaveBeenCalled();
  });
});
