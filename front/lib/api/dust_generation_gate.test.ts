import {
  authorizeDirectDustGenerationAttempt,
  authorizeDustGenerationAttempt,
  consumeDustProviderPermit,
  DIRECT_POC_TENANT_ID,
  DustGenerationGateUnavailable,
} from "@app/lib/api/dust_generation_gate";
import type {
  ActiveDustIdentity,
  DustTenantRouteResolver,
  TenantRoute,
} from "@app/lib/api/tenant_route";
import {
  DustAdmissionDeniedError,
  requireDustAdmission,
} from "@app/lib/api/usage_admission";
import {
  newFrontUsageAttemptId,
  settleFrontUsageNoCharge,
  startFrontUsageAttempt,
  startFrontUsageAttemptForAdmission,
  sumFrontUsageExactTokensSince,
} from "@app/lib/api/usage_journal";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/usage_admission", async (importOriginal) => ({
  ...(await importOriginal()),
  requireDustAdmission: vi.fn(),
}));
vi.mock("@app/lib/api/usage_journal", () => ({
  newFrontUsageAttemptId: vi.fn(),
  startFrontUsageAttempt: vi.fn(),
  startFrontUsageAttemptForAdmission: vi.fn(),
  settleFrontUsageNoCharge: vi.fn(),
  sumFrontUsageExactTokensSince: vi.fn(),
}));

const admit = vi.mocked(requireDustAdmission);
const newId = vi.mocked(newFrontUsageAttemptId);
const start = vi.mocked(startFrontUsageAttemptForAdmission);
const noCharge = vi.mocked(settleFrontUsageNoCharge);
const startDirect = vi.mocked(startFrontUsageAttempt);
const usedTokens = vi.mocked(sumFrontUsageExactTokensSince);

function identity(tenant: "a" | "b"): ActiveDustIdentity {
  return {
    workspaceId: `workspace-${tenant}`,
    workosOrganizationId: `org-${tenant}`,
    workosUserId: `workos-${tenant}`,
    dustUserId: `dust-${tenant}`,
  };
}

function route(tenant: "a" | "b"): TenantRoute {
  return {
    tenantId: `tenant-${tenant}`,
    workspaceId: `workspace-${tenant}`,
    revision: 23,
    keyId: "ed25519-key",
    privateRoute: `https://crm-${tenant}.internal`,
    admissionUrl: `https://crm-${tenant}.internal/internal/usage/dust/admission`,
    usageIngestUrl: `https://crm-${tenant}.internal/internal/usage/events`,
    journalTarget: `tenant:tenant-${tenant}:dust-usage`,
    frontCredentialRef: `/var/run/secrets/dust/tenants/tenant-${tenant}/dust-front-usage-key`,
    coreCredentialRef: `/var/run/secrets/dust/tenants/tenant-${tenant}/dust-core-usage-key`,
  };
}

function resolver(): DustTenantRouteResolver {
  return {
    resolve: vi.fn((active: ActiveDustIdentity) => {
      const tenant = active.workspaceId === "workspace-a" ? "a" : "b";
      if (
        active.workosOrganizationId !== `org-${tenant}` ||
        active.workosUserId !== `workos-${tenant}` ||
        active.dustUserId !== `dust-${tenant}`
      ) {
        throw new Error("unbound identity");
      }
      return route(tenant);
    }),
  } as unknown as DustTenantRouteResolver;
}

function input(tenant: "a" | "b", selected = resolver()) {
  return {
    identity: identity(tenant),
    conversationId: `conversation-${tenant}`,
    model: "google/gemini-2.5-flash",
    pocEnabled: true,
    resolver: selected,
  };
}

describe("Dust Front generation gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    let next = 0;
    newId.mockImplementation(() => `attempt-${++next}`);
    start.mockImplementation(async (attempt) => ({
      attemptId: attempt.attemptId,
    }));
    admit.mockResolvedValue(undefined);
    noCharge.mockResolvedValue(undefined);
  });

  it("selects distinct A/B credentials and returns no route or key", async () => {
    const selected = resolver();
    const a = await authorizeDustGenerationAttempt(input("a", selected));
    const b = await authorizeDustGenerationAttempt(input("b", selected));

    expect(selected.resolve).toHaveBeenNthCalledWith(1, identity("a"));
    expect(selected.resolve).toHaveBeenNthCalledWith(2, identity("a"));
    expect(selected.resolve).toHaveBeenNthCalledWith(3, identity("b"));
    expect(selected.resolve).toHaveBeenNthCalledWith(4, identity("b"));
    expect(admit).toHaveBeenNthCalledWith(1, {
      route: route("a"),
      identity: identity("a"),
      resolver: selected,
      operationId: "attempt-1",
      startPermit: { attemptId: "attempt-1" },
    });
    expect(admit).toHaveBeenNthCalledWith(2, {
      route: route("b"),
      identity: identity("b"),
      resolver: selected,
      operationId: "attempt-2",
      startPermit: { attemptId: "attempt-2" },
    });
    expect(Object.keys(a)).toEqual(["attempt", "providerPermit"]);
    expect(consumeDustProviderPermit({}, "attempt-1")).toBe(false);
    expect(consumeDustProviderPermit(a.providerPermit, "attempt-2")).toBe(
      false
    );
    expect(consumeDustProviderPermit(a.providerPermit, "attempt-1")).toBe(true);
    expect(consumeDustProviderPermit(a.providerPermit, "attempt-1")).toBe(
      false
    );
    expect(a.attempt).toMatchObject({
      attemptId: "attempt-1",
      tenantId: "tenant-a",
      routeId: "tenant-a:23",
    });
    expect(b.attempt.tenantId).toBe("tenant-b");
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.attempt)).toBe(true);
  });

  it("cannot select a tenant, route, or key through untrusted extra input", async () => {
    const selected = resolver();
    const forged = {
      ...input("a", selected),
      tenantId: "tenant-b",
      routeUrl: route("b").admissionUrl,
      componentKey: "b".repeat(40),
    };
    await authorizeDustGenerationAttempt(forged);
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        route: route("a"),
      })
    );
    expect(admit).not.toHaveBeenCalledWith(
      expect.objectContaining({ route: route("b") })
    );
  });

  it("rejects an identity without the signed WorkOS and Dust user binding", async () => {
    await expect(
      authorizeDustGenerationAttempt({
        ...input("a"),
        identity: { ...identity("a"), workosUserId: "workos-b" },
      })
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);
    expect(start).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("denies a disabled POC before resolving a route or starting a journal", async () => {
    const selected = resolver();
    await expect(
      authorizeDustGenerationAttempt({
        ...input("a", selected),
        pocEnabled: false,
      })
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);
    expect(selected.resolve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it("starts durably before CRM admission and uses a new ID per retry", async () => {
    const order: string[] = [];
    start.mockImplementation(async (attempt) => {
      order.push("start");
      return { attemptId: attempt.attemptId };
    });
    admit.mockImplementation(async () => {
      order.push("admit");
    });
    const first = await authorizeDustGenerationAttempt(input("a"));
    const retry = await authorizeDustGenerationAttempt(input("a"));
    expect(order).toEqual(["start", "admit", "start", "admit"]);
    expect(first.attempt.attemptId).toBe("attempt-1");
    expect(retry.attempt.attemptId).toBe("attempt-2");
  });

  it("settles without dispatch if the signed mapping changes during admission", async () => {
    const selected = resolver();
    vi.mocked(selected.resolve)
      .mockReturnValueOnce(route("a"))
      .mockReturnValueOnce({ ...route("a"), revision: 24 });
    await expect(
      authorizeDustGenerationAttempt(input("a", selected))
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);
    expect(noCharge).toHaveBeenCalledWith(
      "attempt-1",
      "predispatch:admission-failed:attempt-1"
    );
  });

  it("accepts a signer key rotation with the same tenant route", async () => {
    const selected = resolver();
    vi.mocked(selected.resolve)
      .mockReturnValueOnce(route("a"))
      .mockReturnValueOnce({ ...route("a"), keyId: "rotated-key" });
    await expect(
      authorizeDustGenerationAttempt(input("a", selected))
    ).resolves.toMatchObject({ attempt: { tenantId: "tenant-a" } });
    expect(noCharge).not.toHaveBeenCalled();
  });

  it.each([
    "denied",
    "unavailable",
  ])("settles a %s CRM failure as explicit pre-dispatch no-charge", async (reason) => {
    admit.mockRejectedValue(
      reason === "denied"
        ? new DustAdmissionDeniedError()
        : new Error("CRM unavailable")
    );
    await expect(
      authorizeDustGenerationAttempt(input("a"))
    ).rejects.toBeInstanceOf(
      reason === "denied"
        ? DustAdmissionDeniedError
        : DustGenerationGateUnavailable
    );
    expect(noCharge).toHaveBeenCalledWith(
      "attempt-1",
      "predispatch:admission-failed:attempt-1"
    );
  });

  it("fails closed on route or journal errors without admission", async () => {
    const selected = resolver();
    vi.mocked(selected.resolve).mockImplementationOnce(() => {
      throw new Error("route failed");
    });
    await expect(
      authorizeDustGenerationAttempt(input("a", selected))
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);

    start.mockRejectedValueOnce(new Error("journal failed"));
    await expect(
      authorizeDustGenerationAttempt(input("a"))
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);
    expect(admit).not.toHaveBeenCalled();
  });

  it("never admits a duplicate or failed pre-dispatch settlement", async () => {
    start.mockResolvedValueOnce(null);
    await expect(
      authorizeDustGenerationAttempt(input("a"))
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);
    expect(admit).not.toHaveBeenCalled();

    admit.mockRejectedValueOnce(new Error("CRM unavailable"));
    noCharge.mockRejectedValueOnce(new Error("journal unavailable"));
    await expect(
      authorizeDustGenerationAttempt(input("a"))
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);
    expect(noCharge).toHaveBeenCalledTimes(1);
  });
});

describe("Dust Front direct POC generation gate", () => {
  function directInput(
    overrides: Partial<
      Parameters<typeof authorizeDirectDustGenerationAttempt>[0]
    > = {}
  ) {
    return {
      identity: identity("a"),
      conversationId: "conversation-a",
      model: "gemini-3.7-flash",
      directWorkspaceId: "workspace-a",
      dailyTokenLimit: 1000,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    let next = 0;
    newId.mockImplementation(() => `direct-${++next}`);
    startDirect.mockResolvedValue("created");
    usedTokens.mockResolvedValue(0);
  });

  it("journals one local attempt and issues a single-use permit", async () => {
    const authorized = await authorizeDirectDustGenerationAttempt(
      directInput()
    );

    expect(authorized.attempt).toEqual({
      attemptId: "direct-1",
      tenantId: DIRECT_POC_TENANT_ID,
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      model: "gemini-3.7-flash",
      routeId: `${DIRECT_POC_TENANT_ID}:0`,
    });
    const [journaled, route] = startDirect.mock.calls[0];
    expect(journaled).toBe(authorized.attempt);
    expect(route).toMatchObject({
      tenantId: DIRECT_POC_TENANT_ID,
      workspaceId: "workspace-a",
      revision: 0,
    });
    // Direct mode has no admission or delivery destination.
    expect(JSON.stringify(route)).not.toContain("http");
    const [tenantId, since] = usedTokens.mock.calls[0];
    expect(tenantId).toBe(DIRECT_POC_TENANT_ID);
    expect(since.toISOString()).toMatch(/T00:00:00\.000Z$/);
    expect(admit).not.toHaveBeenCalled();
    expect(
      consumeDustProviderPermit(authorized.providerPermit, "direct-1")
    ).toBe(true);
    expect(
      consumeDustProviderPermit(authorized.providerPermit, "direct-1")
    ).toBe(false);
  });

  it("serves only the configured workspace", async () => {
    await expect(
      authorizeDirectDustGenerationAttempt(
        directInput({ identity: identity("b") })
      )
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);
    expect(usedTokens).not.toHaveBeenCalled();
    expect(startDirect).not.toHaveBeenCalled();
  });

  it("refuses once the daily token limit is reached", async () => {
    usedTokens.mockResolvedValueOnce(1000);
    await expect(
      authorizeDirectDustGenerationAttempt(directInput())
    ).rejects.toBeInstanceOf(DustAdmissionDeniedError);
    // A refused request never mints an attempt or journal row.
    expect(newId).not.toHaveBeenCalled();
    expect(startDirect).not.toHaveBeenCalled();

    usedTokens.mockResolvedValueOnce(999);
    await expect(
      authorizeDirectDustGenerationAttempt(directInput())
    ).resolves.toMatchObject({ attempt: { attemptId: "direct-1" } });
    expect(startDirect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unreadable journal", () => usedTokens.mockRejectedValue(new Error())],
    [
      "a failed journal start",
      () => startDirect.mockRejectedValue(new Error()),
    ],
    ["a duplicate attempt", () => startDirect.mockResolvedValue("duplicate")],
  ])("fails closed on %s", async (_label, arrange) => {
    arrange();
    await expect(
      authorizeDirectDustGenerationAttempt(directInput())
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
  ])("rejects a daily token limit of %s", async (dailyTokenLimit) => {
    await expect(
      authorizeDirectDustGenerationAttempt(directInput({ dailyTokenLimit }))
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);
    expect(usedTokens).not.toHaveBeenCalled();
  });
});
