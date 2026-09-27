import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createWorker: vi.fn(),
  run: vi.fn(),
  shutdown: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@app/lib/api/instrumentation/init", () => ({
  initializeOpenTelemetryInstrumentation: vi.fn(),
  resource: {},
}));
vi.mock("@app/lib/api/instrumentation/noop_span_exporter", () => ({
  NoopSpanExporter: class {},
}));
vi.mock("@app/lib/shutdown_signal", () => ({
  markShuttingDownWithDelayedAbort: vi.fn(),
}));
vi.mock("@app/lib/temporal", () => ({
  getTemporalAgentWorkerConnection: vi.fn(async () => ({
    connection: { close: mocks.close },
    namespace: "default",
  })),
}));
vi.mock("@app/lib/temporal_monitoring", () => ({
  ActivityInboundLogInterceptor: class {},
}));
vi.mock("@app/logger/logger", () => ({
  default: { error: mocks.logError },
}));
vi.mock("@app/temporal/bundle_helper", () => ({
  createTemporalWorker: mocks.createWorker,
  getWorkflowConfig: vi.fn(() => ({})),
}));
vi.mock("@app/temporal/agent_loop/sinks", () => ({
  instrumentationSinks: {},
}));
vi.mock("@app/temporal/agent_loop/activities/compaction", () => ({
  compactionActivity: vi.fn(),
  compactionCleanupActivity: vi.fn(),
}));
vi.mock("@app/temporal/agent_loop/activities/credit_check", () => ({
  checkCreditsActivity: vi.fn(),
}));
vi.mock(
  "@app/temporal/agent_loop/activities/ensure_conversation_title",
  () => ({
    ensureConversationTitleActivity: vi.fn(),
  })
);
vi.mock("@app/temporal/agent_loop/activities/finalize", () => ({
  finalizeCancelledAgentLoopActivity: vi.fn(),
  finalizeCreditStoppedAgentLoopActivity: vi.fn(),
  finalizeErroredAgentLoopActivity: vi.fn(),
  finalizeGracefullyStoppedAgentLoopActivity: vi.fn(),
  finalizeInterruptedAgentLoopActivity: vi.fn(),
  finalizeSuccessfulAgentLoopActivity: vi.fn(),
}));
vi.mock(
  "@app/temporal/agent_loop/activities/finalize_sandbox_child_tool",
  () => ({
    finalizeErroredSandboxChildToolActivity: vi.fn(),
  })
);
vi.mock("@app/temporal/agent_loop/activities/publish_deferred_events", () => ({
  publishDeferredEventsActivity: vi.fn(),
}));
vi.mock(
  "@app/temporal/agent_loop/activities/run_model_and_create_actions_wrapper",
  () => ({
    runModelAndCreateActionsActivity: vi.fn(),
  })
);
vi.mock("@app/temporal/agent_loop/activities/run_tool", () => ({
  runToolActivity: vi.fn(),
}));
vi.mock("@temporalio/interceptors-opentelemetry/lib/worker", () => ({
  makeWorkflowExporter: vi.fn(),
  OpenTelemetryActivityInboundInterceptor: class {},
  OpenTelemetryActivityOutboundInterceptor: class {},
}));

import { runAgentLoopBatchWorker } from "./worker";

describe("agent loop worker lifecycle", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns cleanly and closes the connection after normal shutdown", async () => {
    mocks.createWorker.mockResolvedValue({
      run: mocks.run.mockResolvedValue(undefined),
      shutdown: mocks.shutdown,
    });

    await expect(runAgentLoopBatchWorker()).resolves.toBeUndefined();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("propagates an unexpected worker error after closing the connection", async () => {
    const failure = new Error("Temporal poller failed");
    mocks.createWorker.mockResolvedValue({
      run: mocks.run.mockRejectedValue(failure),
      shutdown: mocks.shutdown,
    });

    await expect(runAgentLoopBatchWorker()).rejects.toBe(failure);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledOnce();
  });
});
