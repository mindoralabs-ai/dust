import { pocRouteResolverForMaintenance } from "@app/lib/api/dust_poc_runtime";
import { runFrontUsageDeliveryBatch } from "@app/lib/api/usage_delivery";
import { runDustPocUsageReconciler } from "@app/temporal/dust_usage/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/dust_poc_runtime", () => ({
  pocRouteResolverForMaintenance: vi.fn(),
}));
vi.mock("@app/lib/api/usage_delivery", () => ({
  runFrontUsageDeliveryBatch: vi.fn(),
}));
vi.mock("@app/logger/logger", () => ({ default: { warn: vi.fn() } }));

const resolveRoute = vi.mocked(pocRouteResolverForMaintenance);
const deliver = vi.mocked(runFrontUsageDeliveryBatch);

describe("Dust POC accounting worker", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("does not start on ordinary Dust instances", async () => {
    vi.stubEnv("DUST_POC_MODE", "0");
    await runDustPocUsageReconciler();
    expect(resolveRoute).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("runs one bounded accounting batch without a provider switch", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    vi.stubEnv("DUST_FRONT_VERTEX_PROVIDER_IO_ENABLED", "0");
    const controller = new AbortController();
    const resolver = { resolve: vi.fn() } as never;
    resolveRoute.mockResolvedValue(resolver);
    deliver.mockImplementation(async () => {
      controller.abort();
      return 1;
    });
    await runDustPocUsageReconciler(controller.signal);
    expect(resolveRoute).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(resolver);
  });
});
