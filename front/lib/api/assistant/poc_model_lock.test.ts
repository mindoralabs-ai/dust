import {
  GEMINI_3_7_FLASH_MODEL_ID,
  GEMINI_3_8_FLASH_MODEL_ID,
} from "@app/types/assistant/models/google_ai_studio";
import { afterEach, describe, expect, it, vi } from "vitest";

// The POC mode is read through a cached configuration, so each case imports a
// fresh module graph.
describe("POC model lock", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("is on in the isolated POC mode", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    const { isPocModelLockEnabled } = await import(
      "@app/lib/api/assistant/poc_model_lock"
    );

    expect(isPocModelLockEnabled()).toBe(true);
  });

  it("is off when the POC mode is unset or disabled", async () => {
    const unset = await import("@app/lib/api/assistant/poc_model_lock");
    expect(unset.isPocModelLockEnabled()).toBe(false);

    vi.resetModules();
    vi.stubEnv("DUST_POC_MODE", "0");
    const disabled = await import("@app/lib/api/assistant/poc_model_lock");
    expect(disabled.isPocModelLockEnabled()).toBe(false);
  });

  it("fails closed on a mistyped POC mode", async () => {
    vi.stubEnv("DUST_POC_MODE", "true");
    const { isPocModelLockEnabled } = await import(
      "@app/lib/api/assistant/poc_model_lock"
    );

    expect(() => isPocModelLockEnabled()).toThrow(
      "Dust POC mode configuration unavailable"
    );
  });

  it("recognizes Gemini 3.7 Flash as the only locked model", async () => {
    const { isPocLockedModelId } = await import(
      "@app/lib/api/assistant/poc_model_lock"
    );

    expect(isPocLockedModelId(GEMINI_3_7_FLASH_MODEL_ID)).toBe(true);
    expect(isPocLockedModelId(GEMINI_3_8_FLASH_MODEL_ID)).toBe(false);
  });
});
