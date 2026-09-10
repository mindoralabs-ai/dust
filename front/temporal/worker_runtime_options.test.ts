import type { Logger } from "@temporalio/common/lib/logger";
import { describe, expect, it } from "vitest";

import { getWorkerRuntimeOptions } from "./worker_runtime_options";

const logger = {} as Logger;

describe("getWorkerRuntimeOptions", () => {
  it("preserves the Datadog OTLP exporter by default", () => {
    expect(getWorkerRuntimeOptions(logger, {})).toEqual({
      logger,
      telemetryOptions: {
        metrics: {
          otel: {
            url: "grpc://datadog-agent.default.svc.cluster.local:4317",
          },
        },
      },
    });
  });

  it("omits only the metrics exporter when explicitly disabled", () => {
    expect(
      getWorkerRuntimeOptions(logger, {
        TEMPORAL_DATADOG_METRICS_ENABLED: "false",
      })
    ).toEqual({ logger });
  });
});
