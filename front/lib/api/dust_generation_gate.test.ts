import { readFile } from "node:fs/promises";
import {
  authorizeDustGenerationAttempt,
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
} from "@app/lib/api/usage_journal";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = vi.fn();
  return { ...actual, default: { ...actual, readFile }, readFile };
});
vi.mock("@app/lib/api/usage_admission", async (importOriginal) => ({
  ...(await importOriginal()),
  requireDustAdmission: vi.fn(),
}));
vi.mock("@app/lib/api/usage_journal", () => ({
  newFrontUsageAttemptId: vi.fn(),
  startFrontUsageAttempt: vi.fn(),
  settleFrontUsageNoCharge: vi.fn(),
}));

const readKey = vi.mocked(readFile);
const admit = vi.mocked(requireDustAdmission);
const newId = vi.mocked(newFrontUsageAttemptId);
const start = vi.mocked(startFrontUsageAttempt);
const noCharge = vi.mocked(settleFrontUsageNoCharge);

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
    readKey.mockImplementation(async (path) =>
      String(path).includes("tenant-a") ? "a".repeat(40) : "b".repeat(40)
    );
    start.mockResolvedValue("created");
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
    expect(readKey).toHaveBeenNthCalledWith(
      1,
      route("a").frontCredentialRef,
      "utf8"
    );
    expect(readKey).toHaveBeenNthCalledWith(
      2,
      route("b").frontCredentialRef,
      "utf8"
    );
    expect(admit).toHaveBeenNthCalledWith(1, {
      routeUrl: route("a").admissionUrl,
      componentKey: "a".repeat(40),
      operationId: "attempt-1",
    });
    expect(admit).toHaveBeenNthCalledWith(2, {
      routeUrl: route("b").admissionUrl,
      componentKey: "b".repeat(40),
      operationId: "attempt-2",
    });
    expect(Object.keys(a)).toEqual(["attempt"]);
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
    expect(readKey).toHaveBeenCalledWith(route("a").frontCredentialRef, "utf8");
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        routeUrl: route("a").admissionUrl,
        componentKey: "a".repeat(40),
      })
    );
    expect(admit).not.toHaveBeenCalledWith(
      expect.objectContaining({ routeUrl: route("b").admissionUrl })
    );
  });

  it("rejects an identity without the signed WorkOS and Dust user binding", async () => {
    await expect(
      authorizeDustGenerationAttempt({
        ...input("a"),
        identity: { ...identity("a"), workosUserId: "workos-b" },
      })
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);
    expect(readKey).not.toHaveBeenCalled();
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
    start.mockImplementation(async () => {
      order.push("start");
      return "created";
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

  it("fails closed on route, key, or journal errors without admission", async () => {
    const selected = resolver();
    vi.mocked(selected.resolve).mockImplementationOnce(() => {
      throw new Error("route failed");
    });
    await expect(
      authorizeDustGenerationAttempt(input("a", selected))
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);

    readKey.mockRejectedValueOnce(new Error("key missing"));
    await expect(
      authorizeDustGenerationAttempt(input("a"))
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);

    start.mockRejectedValueOnce(new Error("journal failed"));
    await expect(
      authorizeDustGenerationAttempt(input("a"))
    ).rejects.toBeInstanceOf(DustGenerationGateUnavailable);
    expect(admit).not.toHaveBeenCalled();
  });

  it("never admits a duplicate or failed pre-dispatch settlement", async () => {
    start.mockResolvedValueOnce("duplicate");
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
