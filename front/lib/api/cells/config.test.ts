import { afterEach, describe, expect, it, vi } from "vitest";

describe("cell catalog", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("limits an isolated POC to its own cell and URL", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    vi.stubEnv("CELL", "cell-00000");
    vi.stubEnv("REGION", "asia-southeast1");
    vi.stubEnv("DUST_US_URL", "https://dust-api-sit.oktocrew.ai");

    const { config } = await import("@app/lib/api/cells/config");

    expect(config.getAllCells()).toEqual([
      {
        name: "cell-00000",
        region: "asia-southeast1",
        url: "https://dust-api-sit.oktocrew.ai",
      },
    ]);
    expect(config.getOtherCells()).toEqual([]);
    expect(config.getCurrentCell()).toBe(config.getCurrentCell());
    expect(config.getCellInfo("cell-00000")).toBe(config.getCurrentCell());
    expect(config.getDustCellSyncEnabled()).toBe(false);
    const { config: regionConfig, REGION_TIMEZONES } = await import(
      "@app/lib/api/regions/config"
    );
    expect(regionConfig.getCurrentRegion()).toBe("asia-southeast1");
    expect(regionConfig.getDustRegionSyncEnabled()).toBe(false);
    expect(REGION_TIMEZONES["asia-southeast1"]).toBe("Asia/Singapore");
    const { getRegionDisplay } = await import("@app/lib/poke/regions");
    expect(getRegionDisplay(regionConfig.getCurrentRegion())).toBe("🇸🇬 SG");
    expect(() => config.getCellInfo("cell-00001")).toThrow(
      "unavailable in the isolated POC"
    );
  });

  it("keeps the upstream peer catalog outside the isolated POC", async () => {
    vi.stubEnv("DUST_POC_MODE", "0");
    vi.stubEnv("CELL", "cell-00000");
    vi.stubEnv("REGION", "asia-southeast1");

    const { config } = await import("@app/lib/api/cells/config");

    expect(config.getAllCells()).toHaveLength(3);
    expect(config.getOtherCells()).toHaveLength(2);
  });

  it("rejects a POC without its local cell URL", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    vi.stubEnv("CELL", "cell-00000");
    vi.stubEnv("REGION", "asia-southeast1");
    vi.stubEnv("DUST_US_URL", "");

    const { config } = await import("@app/lib/api/cells/config");

    expect(() => config.getCurrentCell()).toThrow(
      "DUST_US_URL is required in the isolated POC"
    );
  });

  it("rejects a POC with a mismatched region", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    vi.stubEnv("CELL", "cell-00000");
    vi.stubEnv("REGION", "us-central1");
    vi.stubEnv("DUST_US_URL", "https://dust-api-sit.oktocrew.ai");

    const { config } = await import("@app/lib/api/cells/config");

    expect(() => config.getCurrentCell()).toThrow(
      "The isolated POC must use the Singapore region"
    );
  });
});
