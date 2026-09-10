import { sanitizeOAuthRegistrationRequestBody } from "@app/lib/api/mcp_server/oauth_registration";
import {
  getMcpAuthorizationServers,
  getMcpAuthorizationServerUrl,
  getMcpProtectedResourcePath,
  getMcpResourceServerUrl,
  getWorkOSAuthKitDomain,
  getWorkOSAuthKitOAuthRegistrationUrl,
  getWorkOSAuthKitOAuthTokenUrl,
  shouldUseProxy,
} from "@app/lib/api/mcp_server/urls";
import { createHono } from "@front-api/lib/hono";
import type { Context } from "hono";

function getProtectedResourceMetadata(dustMcpServerUrl: string) {
  return {
    resource: dustMcpServerUrl,
    authorization_servers: getMcpAuthorizationServers(),
    bearer_methods_supported: ["header"],
  } as const;
}

function serveProtectedResourceMetadata(
  c: {
    json: (body: unknown) => Response;
  },
  dustMcpServerUrl: string,
) {
  return c.json(getProtectedResourceMetadata(dustMcpServerUrl));
}

type OAuthAuthorizationServerMetadata = {
  token_endpoint?: string;
  registration_endpoint?: string;
  [key: string]: unknown;
};

function rewriteAuthorizationServerMetadataForBrowserClients(
  metadata: OAuthAuthorizationServerMetadata,
): OAuthAuthorizationServerMetadata {
  const mcpAuthorizationServerUrl = getMcpAuthorizationServerUrl();
  return {
    ...metadata,
    token_endpoint: `${mcpAuthorizationServerUrl}/oauth2/token`,
    ...(metadata.registration_endpoint
      ? {
          registration_endpoint: `${mcpAuthorizationServerUrl}/oauth2/register`,
        }
      : {}),
  };
}

async function serveAuthorizationServerMetadata(
  c: { json: (body: unknown, status?: number) => Response },
  authorizationServerMetadataUrl: URL,
) {
  const response = await fetch(authorizationServerMetadataUrl);
  const metadata = (await response.json()) as OAuthAuthorizationServerMetadata;

  if (!response.ok) {
    return c.json(metadata, response.status);
  }

  if (!shouldUseProxy()) {
    return c.json(metadata);
  }

  return c.json(rewriteAuthorizationServerMetadataForBrowserClients(metadata));
}

async function proxyOAuthPostRequest(
  c: Context,
  upstreamUrl: string,
): Promise<Response> {
  const headers = new Headers();
  const contentType = c.req.header("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }
  const accept = c.req.header("accept");
  if (accept) {
    headers.set("accept", accept);
  }

  const body = sanitizeOAuthRegistrationRequestBody(await c.req.text());

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body,
  });

  const responseHeaders = new Headers();
  const responseContentType = response.headers.get("content-type");
  if (responseContentType) {
    responseHeaders.set("content-type", responseContentType);
  }

  const responseBody = await response.text();
  return new Response(responseBody, {
    status: response.status,
    headers: responseHeaders,
  });
}

/** Build external MCP discovery routes only after startup configuration enables them. */
export function createMcpWellKnownApp() {
  const app = createHono();
  const workOSAuthKitDomain = getWorkOSAuthKitDomain();
  const dustMcpServerUrl = getMcpResourceServerUrl();
  const protectedResourcePath = getMcpProtectedResourcePath(dustMcpServerUrl);
  const authorizationServerMetadataUrl = new URL(
    "/.well-known/oauth-authorization-server",
    workOSAuthKitDomain,
  );

  // Path-aware discovery for → /.well-known/oauth-protected-resource/mcp
  app.get(protectedResourcePath, (c) =>
    serveProtectedResourceMetadata(c, dustMcpServerUrl),
  );

  // RFC 9728 root fallback used by some clients and WorkOS docs examples.
  app.get("/.well-known/oauth-protected-resource", (c) =>
    serveProtectedResourceMetadata(c, dustMcpServerUrl),
  );

  // Compatibility fallback for clients that look for Authorization Server
  // Metadata on the MCP host instead of following the protected resource metadata.
  app.get("/.well-known/oauth-authorization-server", (c) =>
    serveAuthorizationServerMetadata(c, authorizationServerMetadataUrl),
  );

  // Browser MCP clients in local dev exchange authorization codes via fetch;
  // proxy token/registration endpoints so CORS is handled by Dust instead of AuthKit.
  if (shouldUseProxy()) {
    app.post("/oauth2/token", async (c) =>
      proxyOAuthPostRequest(c, getWorkOSAuthKitOAuthTokenUrl()),
    );

    app.post("/oauth2/register", async (c) =>
      proxyOAuthPostRequest(c, getWorkOSAuthKitOAuthRegistrationUrl()),
    );
  }

  return app;
}
