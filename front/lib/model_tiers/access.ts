import type { Authenticator } from "@app/lib/auth";
import { getAgentAllowedTierNamesOverride } from "@app/lib/model_tiers/agent_tier_overrides";
import { resolveAllowedTierNames } from "@app/lib/model_tiers/allowed_tiers";
import type {
  AgentConfigurationScope,
  GenericErrorContent,
} from "@app/types/assistant/agent";
import { isModelStreamId } from "@app/types/assistant/models/auto";
import type { ModelsTierName } from "@app/types/assistant/models/model_tiers";
import { getTierForModel } from "@app/types/assistant/models/model_tiers";
import type {
  ModelConfigurationType,
  ModelResolutionMethodType,
  ReasoningEffort,
} from "@app/types/assistant/models/types";
import { getMinimumReasoningEffort } from "@app/types/assistant/models/types";
import { areRestrictedModelsAllowedForPublishedAgents } from "@app/types/user";

const MODEL_TIER_NOT_ENABLED_ERROR_CODE = "model_tier_not_enabled";

function buildModelTierAccessDeniedError(
  agentName: string
): GenericErrorContent {
  return {
    code: MODEL_TIER_NOT_ENABLED_ERROR_CODE,
    message:
      `Assistant ${agentName} uses a model tier that is not enabled for you. ` +
      `Please contact your workspace admin or use another assistant.`,
    metadata: {
      errorTitle: "Model tier not enabled",
      category: "unknown_error",
    },
  };
}

export async function getModelTierAccessErrorForAgentConfiguration(
  auth: Authenticator,
  {
    agentSId,
    agentName,
    model,
    reasoningEffort,
    agentScope,
    modelResolutionMethod,
    memberTierNames,
  }: {
    // Left out when the agent has no sId yet (creation): no agent override applies.
    agentSId?: string;
    agentName: string;
    model: ModelConfigurationType;
    reasoningEffort?: ReasoningEffort;
    agentScope?: AgentConfigurationScope;
    modelResolutionMethod?: ModelResolutionMethodType | null;
    // The member's own tier grants, when the caller checks several agents and
    // has resolved them once already.
    memberTierNames?: ModelsTierName[];
  }
): Promise<GenericErrorContent | null> {
  // Workspace admins can allow members to run published agents whose model
  // tier is above the member's own access.
  if (
    agentScope === "visible" &&
    areRestrictedModelsAllowedForPublishedAgents(auth.getNonNullableWorkspace())
  ) {
    return null;
  }

  // A stream only ever resolves to a candidate within the member's cap, so the
  // resolved model can never reveal that the member was not allowed to run the
  // stream in the first place. Tier-check the stream itself instead: it is
  // tiered as the tier it is named after, at its only effort (`none`).
  const tierName =
    modelResolutionMethod && isModelStreamId(modelResolutionMethod)
      ? getTierForModel(modelResolutionMethod, "none")
      : getTierForModel(
          model.modelId,
          reasoningEffort ??
            getMinimumReasoningEffort(model.supportedReasoningEfforts)
        );

  if (!tierName) {
    return null;
  }

  const allowedTierNamesOverride = agentSId
    ? getAgentAllowedTierNamesOverride(agentSId)
    : null;
  const allowedTierNames =
    allowedTierNamesOverride ??
    memberTierNames ??
    (await resolveAllowedTierNames(auth)).tiers;

  if (allowedTierNames.includes(tierName)) {
    return null;
  }

  return buildModelTierAccessDeniedError(agentName);
}
