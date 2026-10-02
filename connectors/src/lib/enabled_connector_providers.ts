import { apiConfig } from "@connectors/lib/api/config";
import type { ConnectorProvider, Result } from "@dust-tt/client";
import { Err, Ok } from "@dust-tt/client";

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
 * @cc [owner:jchen0824,label:security] connectors-provider-groups
 * `PROVIDER_GROUPS[worker]` lists the connector providers that the Temporal worker `worker` of
 * `WORKER_PROVIDERS` does work for together. They share that worker's workflows, activities and
 * code, which do not check which of them a connector belongs to, so a list MUST enable all of them
 * or none.
 */
export const PROVIDER_GROUPS = {
  slack: ["slack", "slack_bot"],
} as const satisfies Record<
  string,
  readonly [ConnectorProvider, ConnectorProvider, ...ConnectorProvider[]]
>;

/**
 * @cc [owner:jchen0824,label:security;error-handling] connectors-enabled-providers-format
 * An unset `CONNECTORS_ENABLED_PROVIDERS` returns `null`: every provider is enabled. A set value,
 * including the empty string, MUST be a comma-separated list of known connector provider names,
 * each trimmed. An empty, unknown or repeated entry returns an error, never a partial list. A list
 * that enables some but not all providers of a `PROVIDER_GROUPS` entry returns an error naming
 * every provider of that group and its worker.
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

  for (const [worker, group] of Object.entries(PROVIDER_GROUPS)) {
    const enabled = group.filter((p) => providers.has(p));
    const missing = group.filter((p) => !providers.has(p));
    if (enabled.length > 0 && missing.length > 0) {
      return new Err(
        new Error(
          `CONNECTORS_ENABLED_PROVIDERS enables ${enabled.join(", ")} but not ${missing.join(", ")}: ` +
            `${group.join(" and ")} share the ${worker} worker and must be enabled together`
        )
      );
    }
  }

  return new Ok(providers);
}

/**
 * Parses this process's `CONNECTORS_ENABLED_PROVIDERS`, read on every call.
 */
export function readEnabledConnectorProviders(): Result<
  ReadonlySet<ConnectorProvider> | null,
  Error
> {
  return parseEnabledConnectorProviders(
    apiConfig.getEnabledConnectorProviders()
  );
}
