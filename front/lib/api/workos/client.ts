import config from "@app/lib/api/config";
import { WorkOS } from "@workos-inc/node";

// SDK default is 60s, which is too long for request-path WorkOS calls
// (workspace creation, domain flows, membership sync). Keep this bounded.
const WORKOS_API_TIMEOUT_MS = 10_000;

let workos: WorkOS | null = null;

/**
 * @cc [owner:jchen0824,label:backend;performance] workos-api-client-configuration
 * The general WorkOS client MUST use the configured API hostname and retain its 10-second timeout.
 */
export function getWorkOS() {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (!workos) {
    workos = new WorkOS(config.getWorkOSApiKey(), {
      clientId: config.getWorkOSClientId(),
      apiHostname: config.getWorkOSApiHostname(),
      timeout: WORKOS_API_TIMEOUT_MS,
    });
  }

  return workos;
}

// Session resolution runs synchronously on every request, so a WorkOS outage
// would otherwise add the full API timeout before falling back to a locally
// cached session. This client is dedicated to that path so it can fail faster.
const SESSION_AUTH_TIMEOUT_MS = 5_000;

let workosForSessionAuth: WorkOS | null = null;

/**
 * @cc [owner:jchen0824,label:backend;performance] workos-session-client-configuration
 * The session WorkOS client MUST use the configured API hostname and retain its 5-second timeout.
 */
export function getWorkOSForSessionAuth() {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (!workosForSessionAuth) {
    workosForSessionAuth = new WorkOS(config.getWorkOSApiKey(), {
      clientId: config.getWorkOSClientId(),
      apiHostname: config.getWorkOSApiHostname(),
      timeout: SESSION_AUTH_TIMEOUT_MS,
    });
  }

  return workosForSessionAuth;
}
