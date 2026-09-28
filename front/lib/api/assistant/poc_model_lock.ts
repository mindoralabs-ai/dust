import { dustPocMode } from "@app/lib/api/dust_poc_mode";
import { GEMINI_3_7_FLASH_MODEL_CONFIG } from "@app/types/assistant/models/google_ai_studio";
import { NOOP_MODEL_ID } from "@app/types/assistant/models/noop";
import type {
  ModelConfigurationType,
  SupportedModel,
} from "@app/types/assistant/models/types";

// Server-only: the isolated POC wires a provider for this model alone.
export const POC_LOCKED_MODEL_CONFIG: ModelConfigurationType =
  GEMINI_3_7_FLASH_MODEL_CONFIG;

/**
 * @cc [owner:jchen0824,label:security;backend] poc-single-model-lock
 * While `dustPocMode()` is true, `getAvailableModelsForWorkspace`, the whitelisted-model
 * lookups of `models.ts`, `resolveModel`, the defaults and stream resolutions of
 * `enabled_models.ts`, `getGlobalAgents`, conversation titles and
 * `createOrUpgradeAgentConfiguration` MUST NOT offer, pick or accept a model other than
 * `POC_LOCKED_MODEL_CONFIG` (the provider-less `noop` model excepted: where noop is enabled,
 * `resolveModel` MUST keep a noop request on it). The message preflights of `conversation.ts`
 * MUST check the model an agent runs, `getPocRuntimeModel`, not the one it was saved on, and
 * refuse it where the workspace cannot run it; a retry MUST NOT reuse a resolution that
 * `isPocRuntimeModel` rejects. The lock MUST NOT make that model available where the
 * workspace's own provider whitelist, plan, region or flags exclude it: lookups then find no
 * model, and a default or stream fallback that must name one marks it unselectable.
 * `getGlobalAgents` MUST also leave out a model agent that the member's tier cap would refuse
 * to run. While it is false, their behaviour MUST be unchanged by this lock.
 */
export function isPocModelLockEnabled(): boolean {
  return dustPocMode();
}

export function isPocLockedModelId(modelId: string): boolean {
  return modelId === POC_LOCKED_MODEL_CONFIG.modelId;
}

// The model a saved agent runs on (see resolveModel): the locked model while the
// lock is enabled, unless the agent is on noop, which keeps its static reply.
export function getPocRuntimeModel(model: SupportedModel): SupportedModel {
  if (!isPocModelLockEnabled() || model.modelId === NOOP_MODEL_ID) {
    return model;
  }

  return {
    providerId: POC_LOCKED_MODEL_CONFIG.providerId,
    modelId: POC_LOCKED_MODEL_CONFIG.modelId,
  };
}

// Whether a model, possibly resolved before the lock was enabled, runs as is.
export function isPocRuntimeModel(model: SupportedModel): boolean {
  const runtimeModel = getPocRuntimeModel(model);
  return (
    runtimeModel.providerId === model.providerId &&
    runtimeModel.modelId === model.modelId
  );
}
