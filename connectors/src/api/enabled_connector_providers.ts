import {
  isKnownConnectorProvider,
  readEnabledConnectorProviders,
} from "@connectors/lib/enabled_connector_providers";
import { apiError } from "@connectors/logger/withlogging";
import type {
  ConnectorsAPIErrorWithStatusCode,
  WithConnectorsAPIErrorReponse,
} from "@connectors/types";
import type { ConnectorProvider, Result } from "@dust-tt/client";
import { Err, Ok } from "@dust-tt/client";
import type { Request, Response } from "express";

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
    return new Err(invalidConfigurationError(enabledRes.error));
  }

  const enabled = enabledRes.value;
  if (
    enabled === null ||
    providers.some((p) => isKnownConnectorProvider(p) && enabled.has(p))
  ) {
    return new Ok(undefined);
  }

  return new Err(notEnabledError(providers));
}

function invalidConfigurationError(
  error: Error
): ConnectorsAPIErrorWithStatusCode {
  return {
    status_code: 500,
    api_error: {
      type: "internal_server_error",
      message: `Invalid connectors configuration: ${error.message}`,
    },
  };
}

function notEnabledError(
  providers: readonly string[]
): ConnectorsAPIErrorWithStatusCode {
  return {
    status_code: 403,
    api_error: {
      type: "invalid_request_error",
      message: `Connector provider not enabled on this deployment: ${providers.join(", ")}`,
    },
  };
}

export function checkConnectorProviderEnabled(
  provider: string
): Result<void, ConnectorsAPIErrorWithStatusCode> {
  return checkAnyConnectorProviderEnabled([provider]);
}

/**
 * @cc [owner:jchen0824,label:security] connectors-enabled-providers-check-resolved
 * When `CONNECTORS_ENABLED_PROVIDERS` is unset, returns `Ok` without calling `resolveProviders`.
 * When the value is malformed, returns 500 `internal_server_error` without calling it. Otherwise
 * returns `Ok` only when `resolveProviders` returns at least one provider and the list enables
 * every one of them, and 403 `invalid_request_error` when it fails, returns no provider, or
 * returns one the list does not enable (naming the first such provider). The value is read once
 * per call.
 */
export async function checkResolvedConnectorProvidersEnabled(
  resolveProviders: () => Promise<Result<readonly ConnectorProvider[], Error>>
): Promise<Result<void, ConnectorsAPIErrorWithStatusCode>> {
  const enabledRes = readEnabledConnectorProviders();
  if (enabledRes.isErr()) {
    return new Err(invalidConfigurationError(enabledRes.error));
  }
  const enabled = enabledRes.value;
  if (enabled === null) {
    return new Ok(undefined);
  }

  const providersRes = await resolveProviders();
  if (providersRes.isErr() || providersRes.value.length === 0) {
    return new Err({
      status_code: 403,
      api_error: {
        type: "invalid_request_error",
        message: `Cannot check which connector providers this request acts on: ${
          providersRes.isErr() ? providersRes.error.message : "it names none"
        }`,
      },
    });
  }

  const disabled = providersRes.value.find((p) => !enabled.has(p));
  if (disabled !== undefined) {
    return new Err(notEnabledError([disabled]));
  }

  return new Ok(undefined);
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
