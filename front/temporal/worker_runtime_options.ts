import type { Logger } from "@temporalio/common/lib/logger";
import type { RuntimeOptions } from "@temporalio/worker";

const DATADOG_OTLP_URL = "grpc://datadog-agent.default.svc.cluster.local:4317";

type WorkerRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export function getWorkerRuntimeOptions(
  logger: Logger,
  environment: WorkerRuntimeEnvironment = process.env
): RuntimeOptions {
  if (environment.TEMPORAL_DATADOG_METRICS_ENABLED === "false") {
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
