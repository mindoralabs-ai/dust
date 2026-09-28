import { DustUsageAttemptResource } from "@app/lib/resources/dust_usage_attempt_resource";

export { DIRECT_POC_TENANT_ID } from "@app/lib/api/tenant_route";
export type {
  FrontUsageAttempt,
  FrontUsageClaim,
  FrontUsageCounts,
  FrontUsageStartPermit,
} from "@app/lib/resources/dust_usage_attempt_resource";
export {
  buildFrontUsageEnvelope,
  DIRECT_POC_ATTEMPT_RESERVATION_TOKENS,
  frontUsageRouteBindingHash,
  newFrontUsageAttemptId,
} from "@app/lib/resources/dust_usage_attempt_resource";

export const readFrontUsageHealth = DustUsageAttemptResource.readHealth;
export const startFrontUsageAttempt = DustUsageAttemptResource.start;
export const startFrontUsageAttemptForAdmission =
  DustUsageAttemptResource.startForAdmission;
export const consumeFrontUsageStartPermit =
  DustUsageAttemptResource.consumeStartPermit;
export const markFrontUsageUnknown = DustUsageAttemptResource.markUnknown;
export const heartbeatFrontUsageAttempt = DustUsageAttemptResource.heartbeat;
export const settleFrontUsageNoCharge = DustUsageAttemptResource.settleNoCharge;
export const settleFrontUsageExact = DustUsageAttemptResource.settleExact;
export const claimFrontUsageWork = DustUsageAttemptResource.claimWork;
export const validateFrontUsageClaim = DustUsageAttemptResource.validateClaim;
export const completeFrontUsageClaim = DustUsageAttemptResource.completeClaim;
export const deferFrontUsageClaim = DustUsageAttemptResource.deferClaim;
export const startDirectFrontUsageAttemptWithinLimit =
  DustUsageAttemptResource.startDirectWithinLimit;
