# Mindora runtime

The capability POC uses hosted WorkOS for employee login (decision: 2026-09-12). Retain Dust's native session, user, organization and membership paths. Custom Mindora login and synchronized Mindora revocation are deferred until after the POC, before real business-data integration or customer rollout.

External MCP access is independent of employee login. When external MCP clients are outside the selected POC scope, set:

```sh
DISABLE_EXTERNAL_MCP_SERVER=true
```

This prevents `front-api` from initializing the root `/mcp` endpoint and its root OAuth discovery
and proxy endpoints. Requests to those paths return `404`. This avoids those routes' eager external
MCP configuration reads; it does not remove the configuration or credentials required by enabled
WorkOS employee login, session refresh, provisioning or membership paths.

The switch only controls Dust acting as an MCP server for remote clients. Workspace-authenticated
Dust APIs and internal MCP tools retain their existing authentication and behavior. The default is
enabled, so deployments that omit the variable keep the existing external MCP server routes.


## WorkOS-first POC qualification

Use controlled internal membership for 5–10 testers in two explicit Dust workspaces. Qualify the
actual WorkOS environment, allowed callback/logout URLs, secret references, provisioning and
webhook/worker dependencies before accepting the login path. Do not enable public or guest signup
as a shortcut. Enterprise SSO and directory synchronization are outside the initial scope.

Maintain durable, server-controlled mappings between stable Mindora employee IDs, existing Dust
user IDs and WorkOS user IDs, plus Mindora tenant, Dust workspace and WorkOS organization IDs.
Operators verify these bindings; email alone cannot establish identity or tenant ownership. Keep
existing Dust user/workspace records when migrating authentication so their app ownership remains
attached to those records. Never fall back to a system API key on invalid identity.

For this POC, operators revoke access in Dust/WorkOS separately from Mindora. Test denial with an
existing session, workspace separation, login/logout and the measured revocation window; do not
claim automatic Mindora revocation. Test credentials or simulated callbacks are not live acceptance.
The later Mindora migration must qualify login handoff, provisioning, session replacement,
revocation and ownership preservation before retiring the WorkOS login path.
