# Mindora runtime

The Mindora POC runs Dust without its external MCP server and WorkOS Connect OAuth surface. Set:

```sh
DISABLE_EXTERNAL_MCP_SERVER=true
```

This prevents `front-api` from initializing the root `/mcp` endpoint and its root OAuth discovery
and proxy endpoints. Requests to those paths return `404`, and startup does not require the external
MCP resource URL or WorkOS AuthKit domain.

The switch only controls Dust acting as an MCP server for remote clients. Workspace-authenticated
Dust APIs and internal MCP tools retain their existing authentication and behavior. The default is
enabled, so deployments that omit the variable keep the existing external MCP server routes.
