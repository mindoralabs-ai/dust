import { readFile } from "node:fs/promises";
import type { TenantRoute } from "@app/lib/api/tenant_route";
import { sendFrontUsageHeartbeat } from "@app/lib/api/usage_heartbeat";
import { readFrontUsageHealth } from "@app/lib/api/usage_journal";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = vi.fn();
  return { ...actual, default: { ...actual, readFile }, readFile };
});
vi.mock("@app/lib/api/usage_journal", () => ({
  readFrontUsageHealth: vi.fn(),
}));

const health = vi.mocked(readFrontUsageHealth);
const key = vi.mocked(readFile);
const route = {
  tenantId: "tenant-a",
  privateRoute: "https://crm-a.internal",
  frontCredentialRef: "/run/tenant-a-front-key",
} as TenantRoute;

describe("Dust Front journal heartbeat", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    health.mockResolvedValue({
      checkedAt: Date.now() / 1000,
      oldestDeliveryAt: 0,
      unresolvedCount: 0,
    });
    key.mockResolvedValue("a".repeat(40));
  });

  it("sends only the signed tenant route and its Front component key", async () => {
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ accepted: true, heartbeat_interval_seconds: 15 })
    );
    await sendFrontUsageHeartbeat(route, fetchImpl as typeof fetch);
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

  it("sends nothing if the journal read or credential fails", async () => {
    const fetchImpl = vi.fn();
    health.mockRejectedValueOnce(new Error("journal unavailable"));
    await expect(
      sendFrontUsageHeartbeat(route, fetchImpl as typeof fetch)
    ).rejects.toThrow();
    key.mockResolvedValueOnce("short");
    await expect(
      sendFrontUsageHeartbeat(route, fetchImpl as typeof fetch)
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires CRM's bounded acknowledgement", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ accepted: false }));
    await expect(
      sendFrontUsageHeartbeat(route, fetchImpl as typeof fetch)
    ).rejects.toThrow("unavailable");
  });
});
