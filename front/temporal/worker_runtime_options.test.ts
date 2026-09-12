import config from "@app/lib/api/config";
import { EnvironmentConfig } from "@app/types/shared/utils/config";
import type { Logger } from "@temporalio/common/lib/logger";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getWorkerRuntimeOptions } from "./worker_runtime_options";

const logger: Logger = {
  log: vi.fn(),
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
afterEach(() => vi.restoreAllMocks());

describe("getWorkerRuntimeOptions", () => {
  it("preserves the Datadog OTLP exporter by default", () => {
    expect(getWorkerRuntimeOptions(logger)).toEqual({
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
    expect(getWorkerRuntimeOptions(logger, false)).toEqual({ logger });
  });
});

describe("worker metrics configuration", () => {
  it.each([
    undefined,
    "true",
    "FALSE",
    "",
    "false",
  ])("handles %s without changing default semantics", (value) => {
    vi.spyOn(EnvironmentConfig, "getOptionalEnvVariable").mockReturnValue(
      value
    );
    expect(config.getTemporalDatadogMetricsEnabled()).toBe(value !== "false");
  });
});
