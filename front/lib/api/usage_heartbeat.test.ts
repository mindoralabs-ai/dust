import { readFile } from "node:fs/promises";
import type {
  DustTenantRouteResolver,
  TenantRoute,
} from "@app/lib/api/tenant_route";
import { runFrontUsageDeliveryBatch } from "@app/lib/api/usage_delivery";
import { sendFrontUsageHeartbeat } from "@app/lib/api/usage_heartbeat";
import {
  claimFrontUsageWork,
  readFrontUsageHealth,
} from "@app/lib/api/usage_journal";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = vi.fn();
  return { ...actual, default: { ...actual, readFile }, readFile };
});
vi.mock("@app/lib/api/usage_journal", () => ({
  claimFrontUsageWork: vi.fn(),
  readFrontUsageHealth: vi.fn(),
}));

const health = vi.mocked(readFrontUsageHealth);
const key = vi.mocked(readFile);
const route = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  privateRoute: "https://crm-a.internal",
  frontCredentialRef: "/run/tenant-a-front-key",
} as TenantRoute;
const resolver = {
  refresh: vi.fn(),
  listActiveRoutesForMaintenance: vi.fn(),
} as unknown as DustTenantRouteResolver;

describe("Dust Front journal heartbeat", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    health.mockResolvedValue({
      checkedAtSeconds: Date.now() / 1000,
      oldestDeliveryAtSeconds: 0,
      unresolvedCount: 0,
    });
    key.mockResolvedValue("a".repeat(40));
    vi.mocked(claimFrontUsageWork).mockResolvedValue([]);
    vi.mocked(resolver.refresh).mockResolvedValue(undefined);
    vi.mocked(resolver.listActiveRoutesForMaintenance).mockReturnValue([route]);
  });

  async function successfulBatch() {
    return runFrontUsageDeliveryBatch({} as DustTenantRouteResolver);
  }

  it("sends only the signed tenant route and its Front component key", async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ accepted: true, heartbeat_interval_seconds: 15 })
    );
    await sendFrontUsageHeartbeat(
      route,
      await successfulBatch(),
      resolver,
      fetchImpl as typeof fetch
    );
    expect(health).toHaveBeenCalledWith("tenant-a");
    expect(key).toHaveBeenCalledWith("/run/tenant-a-front-key", "utf8");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://crm-a.internal/internal/usage/producers/dust-front/heartbeat",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Auth": "a".repeat(40),
        },
      })
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
    expect(body).toEqual(
      expect.objectContaining({
        tenant_id: "tenant-a",
        journal_healthy: true,
        unresolved_count: 0,
        oldest_delivery_at: 0,
      })
    );
  });

  it("does not expose the private destination in transport failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("request to https://crm-a.internal failed"));
    await expect(
      sendFrontUsageHeartbeat(
        route,
        await successfulBatch(),
        resolver,
        fetchImpl
      )
    ).rejects.toEqual(new Error("Dust Front usage heartbeat unavailable"));
  });

  it("sends nothing if the journal read or credential fails", async () => {
    const fetchImpl = vi.fn();
    health.mockRejectedValueOnce(new Error("journal unavailable"));
    await expect(
      sendFrontUsageHeartbeat(
        route,
        await successfulBatch(),
        resolver,
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow();
    key.mockResolvedValueOnce("short");
    await expect(
      sendFrontUsageHeartbeat(
        route,
        await successfulBatch(),
        resolver,
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes the signed route instead of sending to a retained destination", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL) =>
      Response.json({ accepted: true, heartbeat_interval_seconds: 15 })
    );
    vi.mocked(resolver.listActiveRoutesForMaintenance).mockReturnValueOnce([
      {
        ...route,
        privateRoute: "https://crm-current.internal",
        frontCredentialRef: "/run/current-front-key",
      },
    ]);
    await sendFrontUsageHeartbeat(
      route,
      await successfulBatch(),
      resolver,
      fetchImpl as typeof fetch
    );
    expect(resolver.refresh).toHaveBeenCalledTimes(1);
    expect(key).toHaveBeenCalledWith("/run/current-front-key", "utf8");
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      "https://crm-current.internal/internal/usage/producers/dust-front/heartbeat"
    );

    vi.mocked(resolver.refresh).mockRejectedValueOnce(new Error("revoked"));
    await expect(
      sendFrontUsageHeartbeat(
        route,
        await successfulBatch(),
        resolver,
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow("revoked");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cannot report a successful reconciler without a fresh batch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      sendFrontUsageHeartbeat(
        route,
        { processed: 0 },
        resolver,
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow("unavailable");
    const success = await successfulBatch();
    health.mockResolvedValue({
      checkedAtSeconds: Date.now() / 1000,
      oldestDeliveryAtSeconds: 0,
      unresolvedCount: 0,
    });
    fetchImpl.mockResolvedValue(
      Response.json({ accepted: true, heartbeat_interval_seconds: 15 })
    );
    await sendFrontUsageHeartbeat(
      route,
      success,
      resolver,
      fetchImpl as typeof fetch
    );
    await expect(
      sendFrontUsageHeartbeat(
        route,
        success,
        resolver,
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow("unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires CRM's bounded acknowledgement", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ accepted: false }));
    await expect(
      sendFrontUsageHeartbeat(
        route,
        await successfulBatch(),
        resolver,
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow("unavailable");
  });
});
