import { dustPocMode } from "@app/lib/api/dust_poc_mode";
import { GEMINI_3_7_FLASH_MODEL_CONFIG } from "@app/types/assistant/models/google_ai_studio";
import type { ModelConfigurationType } from "@app/types/assistant/models/types";

// Server-only: the isolated POC wires a provider for this model alone.
export const POC_LOCKED_MODEL_CONFIG: ModelConfigurationType =
  GEMINI_3_7_FLASH_MODEL_CONFIG;

/**
 * @cc [owner:jchen0824,label:security;backend] poc-single-model-lock
 * While `dustPocMode()` is true, `getAvailableModelsForWorkspace`, the whitelisted-model
 * lookups of `models.ts`, `resolveModel`, `getGlobalAgents`, conversation titles and
 * `createOrUpgradeAgentConfiguration` MUST NOT offer, pick or accept a model other than
 * `POC_LOCKED_MODEL_CONFIG` (the provider-less `noop` model excepted). The lock MUST NOT make
 * that model available where the workspace's own provider whitelist, plan, region or flags
 * exclude it: lookups then find no model. While it is false, their behaviour MUST be unchanged
 * by this lock.
 */
export function isPocModelLockEnabled(): boolean {
  return dustPocMode();
}

export function isPocLockedModelId(modelId: string): boolean {
  return modelId === POC_LOCKED_MODEL_CONFIG.modelId;
}
