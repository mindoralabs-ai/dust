import { apiConfig } from "@connectors/lib/api/config";
import { apiError } from "@connectors/logger/withlogging";
import type {
  ConnectorsAPIErrorWithStatusCode,
  WithConnectorsAPIErrorReponse,
} from "@connectors/types";
import type { ConnectorProvider, Result } from "@dust-tt/client";
import { Err, Ok } from "@dust-tt/client";
import type { Request, Response } from "express";

// Keyed by `ConnectorProvider` so that a provider added upstream fails type-checking here until it
// is listed. `isConnectorProvider` cannot validate names: it accepts any string.
const KNOWN_CONNECTOR_PROVIDERS: Record<ConnectorProvider, true> = {
  bigquery: true,
  confluence: true,
  discord_bot: true,
  dust_project: true,
  github: true,
  gong: true,
  google_drive: true,
  intercom: true,
  microsoft: true,
  microsoft_bot: true,
  notion: true,
  salesforce: true,
  slack: true,
  slack_bot: true,
  snowflake: true,
  webcrawler: true,
  zendesk: true,
};

export function isKnownConnectorProvider(
  name: string
): name is ConnectorProvider {
  return Object.hasOwn(KNOWN_CONNECTOR_PROVIDERS, name);
}

/**
 * @cc [owner:jchen0824,label:security;error-handling] connectors-enabled-providers-format
 * An unset `CONNECTORS_ENABLED_PROVIDERS` returns `null`: every provider is enabled. A set value,
 * including the empty string, MUST be a comma-separated list of known connector provider names,
 * each trimmed. An empty, unknown or repeated entry returns an error, never a partial list.
 */
export function parseEnabledConnectorProviders(
  value: string | undefined
): Result<ReadonlySet<ConnectorProvider> | null, Error> {
  if (value === undefined) {
    return new Ok(null);
  }

  const providers = new Set<ConnectorProvider>();
  for (const entry of value.split(",")) {
    const name = entry.trim();
    if (!name) {
      return new Err(
        new Error("CONNECTORS_ENABLED_PROVIDERS has an empty entry")
      );
    }
    if (!isKnownConnectorProvider(name)) {
      return new Err(
        new Error(
          `CONNECTORS_ENABLED_PROVIDERS names an unknown connector provider: ${name}`
        )
      );
    }
    if (providers.has(name)) {
      return new Err(
        new Error(`CONNECTORS_ENABLED_PROVIDERS lists ${name} more than once`)
      );
    }
    providers.add(name);
  }

  return new Ok(providers);
}

/**
 * Parses this deployment's `CONNECTORS_ENABLED_PROVIDERS`, read on every call.
 */
export function readEnabledConnectorProviders(): Result<
  ReadonlySet<ConnectorProvider> | null,
  Error
> {
  return parseEnabledConnectorProviders(
    apiConfig.getEnabledConnectorProviders()
  );
}

/**
 * @cc [owner:jchen0824,label:security] connectors-enabled-providers-check
 * Returns `Ok` when `CONNECTORS_ENABLED_PROVIDERS` is unset or lists at least one of `providers`.
 * Otherwise returns the API error to send: 403 `invalid_request_error` when none of `providers` is
 * listed, 500 `internal_server_error` when the value is malformed. A malformed value enables no
 * provider. The value is read on every call.
 */
function checkAnyConnectorProviderEnabled(
  providers: readonly string[]
): Result<void, ConnectorsAPIErrorWithStatusCode> {
  const enabledRes = readEnabledConnectorProviders();
  if (enabledRes.isErr()) {
    return new Err({
      status_code: 500,
      api_error: {
        type: "internal_server_error",
        message: `Invalid connectors configuration: ${enabledRes.error.message}`,
      },
    });
  }

  const enabled = enabledRes.value;
  if (
    enabled === null ||
    providers.some((p) => isKnownConnectorProvider(p) && enabled.has(p))
  ) {
    return new Ok(undefined);
  }

  return new Err({
    status_code: 403,
    api_error: {
      type: "invalid_request_error",
      message: `Connector provider not enabled on this deployment: ${providers.join(", ")}`,
    },
  });
}

export function checkConnectorProviderEnabled(
  provider: string
): Result<void, ConnectorsAPIErrorWithStatusCode> {
  return checkAnyConnectorProviderEnabled([provider]);
}

/**
 * Wraps a handler dedicated to `providers` (a provider's webhooks or routes) so that it runs only
 * when at least one of them is enabled.
 */
export function withEnabledConnectorProviders<
  P extends Record<string, string>,
  ResBody,
  ReqBody,
>(
  providers: readonly ConnectorProvider[],
  handler: (
    req: Request<P, WithConnectorsAPIErrorReponse<ResBody>, ReqBody>,
    res: Response<WithConnectorsAPIErrorReponse<ResBody>>
  ) => Promise<unknown>
) {
  return async (
    req: Request<P, WithConnectorsAPIErrorReponse<ResBody>, ReqBody>,
    res: Response<WithConnectorsAPIErrorReponse<ResBody>>
  ) => {
    const enabledRes = checkAnyConnectorProviderEnabled(providers);
    if (enabledRes.isErr()) {
      return apiError(req, res, enabledRes.error);
    }

    return handler(req, res);
  };
}
