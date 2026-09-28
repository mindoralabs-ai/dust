import { LightWorkspaceFactory } from "@app/tests/utils/LightWorkspaceFactory";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/auth/AuthContext", () => ({
  useAuth: () => ({
    subscription: {
      plan: { code: "PRO_PLAN_SEAT_29", hasAdvancedModelAccess: true },
    },
  }),
  useFeatureFlags: () => ({ hasFeature: () => false }),
}));

vi.mock("@app/lib/auth/CellContext", () => ({
  useCellContext: () => ({ cellInfo: { region: "asia-southeast1" } }),
}));

vi.mock("@app/lib/swr/models", () => ({
  useModels: () => ({
    models: [],
    streams: null,
    degradedModelIds: new Set(),
    isModelsLoading: false,
  }),
}));

// The POC flag is read when the module loads, so each case imports it afresh.
async function renderTierNames(): Promise<string[]> {
  const { useModelPickerModels } = await import(
    "@app/components/model_picker/useModelPickerModels"
  );
  const owner = LightWorkspaceFactory.build();
  const { result } = renderHook(() => useModelPickerModels({ owner }));

  return result.current.modelProps.tiers.map((tier) => tier.name);
}

describe("useModelPickerModels tiers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("offers the Basic, Standard and Premium tiers", async () => {
    expect(await renderTierNames()).toEqual(["Basic", "Standard", "Premium"]);
  });

  it("offers no tier in the isolated POC, which runs a single model", async () => {
    vi.stubEnv("VITE_DUST_POC_MODE", "1");

    expect(await renderTierNames()).toEqual([]);
  });
});
