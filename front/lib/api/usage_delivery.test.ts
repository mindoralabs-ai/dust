import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DustTenantRouteResolver } from "@app/lib/api/tenant_route";
import {
  deliverFrontUsageClaim,
  runFrontUsageDeliveryBatch,
} from "@app/lib/api/usage_delivery";
import type { FrontUsageClaim } from "@app/lib/api/usage_journal";
import {
  claimFrontUsageWork,
  completeFrontUsageClaim,
  deferFrontUsageClaim,
  validateFrontUsageClaim,
} from "@app/lib/api/usage_journal";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = vi.fn();
  return { ...actual, default: { ...actual, readFile }, readFile };
});
vi.mock("@app/lib/api/usage_journal", () => ({
  claimFrontUsageWork: vi.fn(),
  completeFrontUsageClaim: vi.fn(),
  deferFrontUsageClaim: vi.fn(),
  validateFrontUsageClaim: vi.fn(),
}));

const envelope =
  '{"agent":"dust","attempt_id":"attempt-1","component":"dust-front","tenant_id":"tenant-a","workspace_id":"workspace-a"}';
const hash = createHash("sha256").update(envelope).digest("hex");
const exact: FrontUsageClaim = {
  attemptId: "attempt-1",
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  routeId: "tenant-a:23",
  state: "exact",
  eventEnvelope: envelope,
  eventHash: hash,
  providerOperationId: "vertex-1",
  firstUnresolvedAt: null,
  retryCount: 0,
  manualReviewRequired: false,
  leaseOwner: "worker-a",
  leaseNonce: "nonce-a",
};
const route = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  usageIngestUrl: "https://crm-a.internal/internal/usage/events",
  frontCredentialRef: "/var/run/secrets/dust/tenant-a/front",
};

describe("Dust Front usage delivery", () => {
  const resolver = {
    refresh: vi.fn(),
    resolveForDelivery: vi.fn(),
  } as unknown as DustTenantRouteResolver;
  const fetchImpl = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(resolver.refresh).mockResolvedValue(undefined);
    vi.mocked(resolver.resolveForDelivery).mockReturnValue(route as never);
    vi.mocked(readFile).mockResolvedValue("a".repeat(40));
    vi.mocked(claimFrontUsageWork).mockResolvedValue([]);
    fetchImpl.mockResolvedValue(
      new Response(
        JSON.stringify({
          stream_id: "123-0",
          envelope_sha256: hash,
          replayed: false,
        }),
        { status: 200 }
      )
    );
  });

  it("delivers frozen bytes to the signer-selected tenant route and checks the receipt", async () => {
    await deliverFrontUsageClaim(exact, resolver, fetchImpl);
    expect(resolver.resolveForDelivery).toHaveBeenCalledWith(
      "tenant-a",
      "tenant-a:23"
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      route.usageIngestUrl,
      expect.objectContaining({
        method: "POST",
        body: envelope,
        headers: expect.objectContaining({ "X-Internal-Auth": "a".repeat(40) }),
      })
    );
    expect(completeFrontUsageClaim).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      leaseOwner: "worker-a",
      leaseNonce: "nonce-a",
      delivered: true,
    });
  });

  it("never sends an unresolved attempt to CRM or retries a model effect", async () => {
    await deliverFrontUsageClaim(
      { ...exact, state: "unknown", eventEnvelope: null },
      resolver,
      fetchImpl
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deferFrontUsageClaim).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      leaseOwner: "worker-a",
      leaseNonce: "nonce-a",
    });
  });

  it("retains exact work when a receipt is for different bytes", async () => {
    fetchImpl.mockResolvedValue(
      new Response(
        JSON.stringify({
          stream_id: "123-0",
          envelope_sha256: "0".repeat(64),
          replayed: false,
        }),
        { status: 200 }
      )
    );
    await deliverFrontUsageClaim(exact, resolver, fetchImpl);
    expect(completeFrontUsageClaim).toHaveBeenCalledWith(
      expect.objectContaining({ delivered: false })
    );
  });

  it("rejects a tenant or workspace mismatch before network delivery", async () => {
    vi.mocked(resolver.resolveForDelivery).mockReturnValue({
      ...route,
      workspaceId: "workspace-b",
    } as never);
    await deliverFrontUsageClaim(exact, resolver, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(completeFrontUsageClaim).toHaveBeenCalledWith(
      expect.objectContaining({ delivered: false })
    );
  });

  it("does not send a stale or modified claim before journal validation", async () => {
    vi.mocked(validateFrontUsageClaim).mockRejectedValueOnce(
      new Error("lost lease")
    );
    await deliverFrontUsageClaim(exact, resolver, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(completeFrontUsageClaim).toHaveBeenCalledWith(
      expect.objectContaining({ delivered: false })
    );
  });

  it("runs a bounded claim batch and returns after its delivery ack", async () => {
    vi.mocked(claimFrontUsageWork).mockResolvedValue([exact]);
    await expect(
      runFrontUsageDeliveryBatch(resolver, fetchImpl)
    ).resolves.toEqual({ processed: 1 });
    expect(claimFrontUsageWork).toHaveBeenCalledWith(
      expect.stringMatching(/^front_[a-f0-9-]+$/),
      20
    );
    expect(completeFrontUsageClaim).toHaveBeenCalledWith(
      expect.objectContaining({ delivered: true })
    );
  });

  it("never delivers more than eight claimed events concurrently", async () => {
    const claims = Array.from({ length: 20 }, (_, index) => {
      const attemptId = `attempt-${index}`;
      const eventEnvelope = envelope.replace("attempt-1", attemptId);
      return {
        ...exact,
        attemptId,
        eventEnvelope,
        eventHash: createHash("sha256").update(eventEnvelope).digest("hex"),
      };
    });
    vi.mocked(claimFrontUsageWork).mockResolvedValue(claims);
    let active = 0;
    let maximum = 0;
    fetchImpl.mockImplementation(async (_url, init) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return new Response(
        JSON.stringify({
          stream_id: "123-0",
          envelope_sha256: createHash("sha256")
            .update(String(init.body))
            .digest("hex"),
          replayed: false,
        }),
        { status: 200 }
      );
    });
    await expect(
      runFrontUsageDeliveryBatch(resolver, fetchImpl)
    ).resolves.toEqual({ processed: 20 });
    expect(maximum).toBeLessThanOrEqual(8);
    expect(maximum).toBeGreaterThan(1);
  });
});
