import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  delete process.env.DISABLE_EXTERNAL_MCP_SERVER;
});

vi.mock("@app/lib/api/mcp_server/urls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/lib/api/mcp_server/urls")>()),
  getMcpResourceServerUrl: () => "http://localhost:3000/mcp",
  getWorkOSAuthKitDomain: () => "https://test.authkit.app",
  getMcpAuthorizationServers: () => ["https://test.authkit.app"],
}));

import { honoApp } from "@front-api/app";

describe("external MCP server default startup", () => {
  it("mounts the MCP endpoint and its protected-resource metadata", async () => {
    const metadataResponse = await honoApp.request(
      "/.well-known/oauth-protected-resource/mcp"
    );
    const mcpResponse = await honoApp.request("/mcp");

    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.json()).toEqual({
      resource: "http://localhost:3000/mcp",
      authorization_servers: ["https://test.authkit.app"],
      bearer_methods_supported: ["header"],
    });
    expect(mcpResponse.status).toBe(401);
    expect(mcpResponse.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"'
    );
  });
});
