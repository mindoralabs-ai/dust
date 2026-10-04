import type { CoreAPIError } from "@app/types/core/core_api";

// Core sends `quota_exceeded` for the direct mode's daily limit (reset at 00:00 UTC) and for the
// signed mode's CRM quota (its own window), so the message names neither.
export const EMBEDDING_QUOTA_EXCEEDED_MESSAGE =
  "The workspace's embedding quota is exhausted. Try again after it resets.";

/**
 * @cc [owner:jchen0824,label:error-handling;api] core-quota-exceeded-stays-distinct
 * A Core error with code `quota_exceeded` MUST NOT be collapsed into a generic error at a Front
 * boundary. Aggregated Core results return it before any other error; `lib/api` functions return
 * the `quota_exceeded` code; HTTP routes answer 429 `rate_limit_error`, and `v1` routes include
 * Core's error as `data_source_error`; agent tools return an untracked tool error with
 * `EMBEDDING_QUOTA_EXCEEDED_MESSAGE`; background paths log Core's error. Other Core errors keep
 * their existing mapping.
 */
export function isCoreQuotaExceededError(error: CoreAPIError): boolean {
  return error.code === "quota_exceeded";
}
