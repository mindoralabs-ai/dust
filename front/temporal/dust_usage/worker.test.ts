import {
  pocRouteResolverForMaintenance,
  pocRoutesForMaintenance,
} from "@app/lib/api/dust_poc_runtime";
import { runFrontUsageDeliveryBatch } from "@app/lib/api/usage_delivery";
import { sendFrontUsageHeartbeat } from "@app/lib/api/usage_heartbeat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/dust_poc_runtime", () => ({
  pocRouteResolverForMaintenance: vi.fn(),
  pocRoutesForMaintenance: vi.fn(),
}));
vi.mock("@app/lib/api/usage_delivery", () => ({
  runFrontUsageDeliveryBatch: vi.fn(),
}));
vi.mock("@app/lib/api/usage_heartbeat", () => ({
  sendFrontUsageHeartbeat: vi.fn(),
}));
vi.mock("@app/logger/logger", () => ({ default: { warn: vi.fn() } }));

const resolveRoute = vi.mocked(pocRouteResolverForMaintenance);
const routesForMaintenance = vi.mocked(pocRoutesForMaintenance);
const deliver = vi.mocked(runFrontUsageDeliveryBatch);
const heartbeat = vi.mocked(sendFrontUsageHeartbeat);

describe("Dust POC accounting worker", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does not start on ordinary Dust instances", async () => {
    vi.stubEnv("DUST_POC_MODE", "0");
    const { runDustPocUsageReconciler } = await import(
      "@app/temporal/dust_usage/worker"
    );
    await runDustPocUsageReconciler();
    expect(resolveRoute).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("runs one bounded accounting batch without a provider switch", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    const { runDustPocUsageReconciler } = await import(
      "@app/temporal/dust_usage/worker"
    );
    vi.stubEnv("DUST_FRONT_VERTEX_PROVIDER_IO_ENABLED", "0");
    const controller = new AbortController();
    const resolver = { resolve: vi.fn() } as never;
    const routeA = { tenantId: "tenant-a" } as never;
    const routeB = { tenantId: "tenant-b" } as never;
    resolveRoute.mockResolvedValue(resolver);
    routesForMaintenance.mockResolvedValue([routeA, routeB]);
    deliver.mockImplementation(async () => {
      return { processed: 1 };
    });
    heartbeat.mockImplementation(async () => {
      if (heartbeat.mock.calls.length === 2) {
        controller.abort();
      }
    });
    await runDustPocUsageReconciler(controller.signal);
    expect(resolveRoute).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(resolver);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(heartbeat).toHaveBeenCalledWith(routeA, { processed: 1 }, resolver);
    expect(heartbeat).toHaveBeenCalledWith(routeB, { processed: 1 }, resolver);
  });

  it("sends no heartbeat until the delivery batch succeeds", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    const { runDustPocUsageReconciler } = await import(
      "@app/temporal/dust_usage/worker"
    );
    const controller = new AbortController();
    let heartbeatBeforeSuccess = false;
    deliver.mockImplementation(async () => {
      heartbeatBeforeSuccess = heartbeat.mock.calls.length > 0;
      return { processed: 0 };
    });
    resolveRoute.mockResolvedValue({ resolve: vi.fn() } as never);
    routesForMaintenance.mockResolvedValue([{ tenantId: "tenant-a" } as never]);
    heartbeat.mockImplementation(async () => {
      controller.abort();
    });
    await runDustPocUsageReconciler(controller.signal);
    expect(heartbeatBeforeSuccess).toBe(false);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
