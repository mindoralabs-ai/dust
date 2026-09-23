import { readFile } from "node:fs/promises";
import type {
  ActiveDustIdentity,
  DustTenantRouteResolver,
} from "@app/lib/api/tenant_route";
import {
  DustAdmissionDeniedError,
  requireDustAdmission,
} from "@app/lib/api/usage_admission";
import type { FrontUsageAttempt } from "@app/lib/api/usage_journal";
import {
  newFrontUsageAttemptId,
  settleFrontUsageNoCharge,
  startFrontUsageAttempt,
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
}>;

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
  let componentKey: string;
  try {
    route = resolver.resolve(identity);
    if (route.workspaceId !== identity.workspaceId) {
      throw new DustGenerationGateUnavailable();
    }
    componentKey = (await readFile(route.frontCredentialRef, "utf8")).trim();
    if (
      componentKey.length < 32 ||
      componentKey.length > 4096 ||
      /[\r\n]/.test(componentKey)
    ) {
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

  try {
    if ((await startFrontUsageAttempt(attempt)) !== "created") {
      throw new DustGenerationGateUnavailable();
    }
  } catch {
    throw new DustGenerationGateUnavailable();
  }

  try {
    await requireDustAdmission({
      routeUrl: route.admissionUrl,
      componentKey,
      operationId: attempt.attemptId,
    });
    // Recheck the signed mapping after the network round trip. If a refresh
    // failed or changed the binding, no provider request has been sent yet.
    const current = resolver.resolve(identity);
    if (
      current.tenantId !== route.tenantId ||
      current.workspaceId !== route.workspaceId ||
      current.revision !== route.revision ||
      current.keyId !== route.keyId ||
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

  return Object.freeze({ attempt });
}
