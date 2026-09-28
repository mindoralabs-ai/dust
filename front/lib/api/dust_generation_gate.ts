import type {
  ActiveDustIdentity,
  DustTenantRouteResolver,
  TenantRoute,
} from "@app/lib/api/tenant_route";
import {
  DustAdmissionDeniedError,
  requireDustAdmission,
} from "@app/lib/api/usage_admission";
import type {
  FrontUsageAttempt,
  FrontUsageStartPermit,
} from "@app/lib/api/usage_journal";
import {
  DIRECT_POC_ATTEMPT_RESERVATION_TOKENS,
  DIRECT_POC_TENANT_ID,
  newFrontUsageAttemptId,
  settleFrontUsageNoCharge,
  startDirectFrontUsageAttemptWithinLimit,
  startFrontUsageAttemptForAdmission,
} from "@app/lib/api/usage_journal";

/** This module is for authenticated server-side generation paths only. */
export class DustGenerationGateUnavailable extends Error {
  constructor() {
    super("Dust generation is unavailable");
    this.name = "DustGenerationGateUnavailable";
  }
}

export type AuthorizedDustGenerationAttempt = Readonly<{
  attempt: Readonly<FrontUsageAttempt>;
  providerPermit: object;
}>;

const providerPermits = new WeakMap<object, string>();

/** A permit is issued only after a durable start and successful admission. */
export function consumeDustProviderPermit(
  permit: object,
  attemptId: string
): boolean {
  if (providerPermits.get(permit) !== attemptId) {
    return false;
  }
  providerPermits.delete(permit);
  return true;
}

export type DustGenerationGateInput = {
  /** Obtained from the authenticated Dust server session, never request JSON. */
  identity: ActiveDustIdentity;
  conversationId: string;
  model: string;
  /** Server-controlled POC workspace switch. False always denies dispatch. */
  pocEnabled: boolean;
  resolver: DustTenantRouteResolver;
};

/**
 * Obtain permission for one provider request. Every provider retry must call
 * this function again; the returned attempt ID must never be reused.
 * The caller must perform provider I/O only after this promise resolves.
 */
export async function authorizeDustGenerationAttempt({
  identity,
  conversationId,
  model,
  pocEnabled,
  resolver,
}: DustGenerationGateInput): Promise<AuthorizedDustGenerationAttempt> {
  if (pocEnabled !== true) {
    throw new DustGenerationGateUnavailable();
  }

  // The route, tenant, and key are deliberately absent from the input. The
  // signer-verified binding chooses all three from the authenticated identity.
  let route: ReturnType<DustTenantRouteResolver["resolve"]>;
  try {
    route = resolver.resolve(identity);
    if (route.workspaceId !== identity.workspaceId) {
      throw new DustGenerationGateUnavailable();
    }
  } catch {
    throw new DustGenerationGateUnavailable();
  }

  const attempt: FrontUsageAttempt = Object.freeze({
    attemptId: newFrontUsageAttemptId(),
    tenantId: route.tenantId,
    workspaceId: route.workspaceId,
    conversationId,
    model,
    // The signed route revision fixes the binding used for reconciliation.
    routeId: `${route.tenantId}:${route.revision}`,
  });

  let startPermit: FrontUsageStartPermit;
  try {
    const started = await startFrontUsageAttemptForAdmission(attempt, route);
    if (!started) {
      throw new DustGenerationGateUnavailable();
    }
    startPermit = started;
  } catch {
    throw new DustGenerationGateUnavailable();
  }

  try {
    await requireDustAdmission({
      route,
      identity,
      resolver,
      operationId: attempt.attemptId,
      startPermit,
    });
    // Recheck the signed mapping after the network round trip. If a refresh
    // failed or changed the binding, no provider request has been sent yet.
    const current = resolver.resolve(identity);
    if (
      current.tenantId !== route.tenantId ||
      current.workspaceId !== route.workspaceId ||
      current.revision !== route.revision ||
      current.admissionUrl !== route.admissionUrl ||
      current.frontCredentialRef !== route.frontCredentialRef
    ) {
      throw new DustGenerationGateUnavailable();
    }
  } catch (error) {
    // This function has not dispatched any provider I/O. Record durable,
    // explicit no-charge evidence for both quota denial and CRM unavailability.
    // A settlement error also denies dispatch; recovery must handle the row.
    try {
      await settleFrontUsageNoCharge(
        attempt.attemptId,
        `predispatch:admission-failed:${attempt.attemptId}`
      );
    } catch {
      throw new DustGenerationGateUnavailable();
    }
    if (error instanceof DustAdmissionDeniedError) {
      throw error;
    }
    throw new DustGenerationGateUnavailable();
  }

  const providerPermit = Object.freeze({});
  providerPermits.set(providerPermit, attempt.attemptId);
  return Object.freeze({ attempt, providerPermit });
}

// Direct mode never admits or delivers remotely, so the route has no network
// destination. Fixed fields keep the journal's route binding stable.
function directPocRoute(workspaceId: string): TenantRoute {
  return Object.freeze({
    tenantId: DIRECT_POC_TENANT_ID,
    workspaceId,
    revision: 0,
    keyId: "direct",
    privateRoute: "direct:none",
    admissionUrl: "direct:none",
    usageIngestUrl: "direct:none",
    journalTarget: `tenant:${DIRECT_POC_TENANT_ID}:dust-usage`,
    frontCredentialRef: "direct:none",
    coreCredentialRef: "direct:none",
  });
}

export type DirectDustGenerationGateInput = {
  /** Obtained from the authenticated Dust server session, never request JSON. */
  identity: ActiveDustIdentity;
  conversationId: string;
  model: string;
  /** The one server-configured workspace direct mode serves. */
  directWorkspaceId: string;
  /** Exact input and output tokens the workspace may use per UTC day. */
  dailyTokenLimit: number;
};

export { DIRECT_POC_TENANT_ID };

/**
 * @cc [owner:jchen0824,label:security;backend] dust-poc-direct-generation
 * Direct provider mode serves exactly one configured POC workspace without the
 * signed registry or CRM admission. Each provider request still needs a newly
 * committed journal row and a single-use permit. The limit check and that row
 * are serialized per workspace, and a request is refused when the workspace's
 * exact tokens for the current UTC day, plus a fixed reservation for each of
 * its unsettled attempts that day including this one, would exceed the limit.
 */
export async function authorizeDirectDustGenerationAttempt({
  identity,
  conversationId,
  model,
  directWorkspaceId,
  dailyTokenLimit,
}: DirectDustGenerationGateInput): Promise<AuthorizedDustGenerationAttempt> {
  if (
    identity.workspaceId !== directWorkspaceId ||
    !Number.isSafeInteger(dailyTokenLimit) ||
    dailyTokenLimit < DIRECT_POC_ATTEMPT_RESERVATION_TOKENS
  ) {
    throw new DustGenerationGateUnavailable();
  }

  const route = directPocRoute(directWorkspaceId);
  const attempt: FrontUsageAttempt = Object.freeze({
    attemptId: newFrontUsageAttemptId(),
    tenantId: route.tenantId,
    workspaceId: route.workspaceId,
    conversationId,
    model,
    routeId: `${route.tenantId}:${route.revision}`,
  });
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  let started: Awaited<
    ReturnType<typeof startDirectFrontUsageAttemptWithinLimit>
  >;
  try {
    started = await startDirectFrontUsageAttemptWithinLimit(attempt, route, {
      since: dayStart,
      dailyTokenLimit,
    });
  } catch {
    throw new DustGenerationGateUnavailable();
  }
  if (started === "over_limit") {
    throw new DustAdmissionDeniedError();
  }
  // A duplicate is never another allowance.
  if (started !== "created") {
    throw new DustGenerationGateUnavailable();
  }

  const providerPermit = Object.freeze({});
  providerPermits.set(providerPermit, attempt.attemptId);
  return Object.freeze({ attempt, providerPermit });
}
