import type { Logger } from "@temporalio/common/lib/logger";
import type { RuntimeOptions } from "@temporalio/worker";

const DATADOG_OTLP_URL = "grpc://datadog-agent.default.svc.cluster.local:4317";

/**
 * @cc [owner:jchen0824,label:logging] worker-metrics-opt-out
 * Metrics MUST retain the upstream exporter unless explicitly disabled. The logger MUST always
 * be retained, including when the metrics exporter is omitted.
 */
export function getWorkerRuntimeOptions(
  logger: Logger,
  metricsEnabled = true
): RuntimeOptions {
  if (!metricsEnabled) {
    return { logger };
  }

  return {
    logger,
    telemetryOptions: {
      metrics: {
        // Datadog Agent OTLP gRPC (4317).
        otel: { url: DATADOG_OTLP_URL },
      },
    },
  };
}
