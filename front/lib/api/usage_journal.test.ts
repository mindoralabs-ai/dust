import {
  buildFrontUsageEnvelope,
  newFrontUsageAttemptId,
  startFrontUsageAttempt,
} from "@app/lib/api/usage_journal";
import { describe, expect, it } from "vitest";

const attempt = {
  attemptId: "attempt-1",
  tenantId: "tenant-a",
  workspaceId: "workspace-A",
  conversationId: "conversation-1",
  model: "gemini-2.5-flash",
  routeId: "tenant-a:7",
};
const counts = {
  inputTokens: 12,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 0,
};

describe("Front Dust usage journal validation", () => {
  it("creates stable distinct retry IDs", () => {
    expect(newFrontUsageAttemptId()).not.toBe(newFrontUsageAttemptId());
  });

  it("rejects a route that cannot be resolved for its tenant", async () => {
    await expect(
      startFrontUsageAttempt({ ...attempt, routeId: "route-a" })
    ).rejects.toThrow("route identity");
    await expect(
      startFrontUsageAttempt({ ...attempt, routeId: "tenant-b:7" })
    ).rejects.toThrow("route identity");
  });

  it("freezes the exact CRM wire envelope without guessed metadata", () => {
    const raw = buildFrontUsageEnvelope({
      attempt,
      providerOperationId: "vertex-operation-1",
      eventTime: new Date("2026-09-23T09:00:00.000Z"),
      counts,
    });
    // Golden vector for CRM's Python json.dumps(sort_keys=True,
    // ensure_ascii=False, separators=(",", ":")) contract.
    expect(raw).toBe(
      '{"agent":"dust","attempt_id":"attempt-1","cache_read_tokens":"2","cache_write_tokens":"0","component":"dust-front","conversation_id":"conversation-1","event_type":"token","input_tokens":"12","model":"gemini-2.5-flash","output_tokens":"5","provider_operation_id":"vertex-operation-1","quantity":"0","tenant_id":"tenant-a","ts":"2026-09-23T09:00:00.000Z","workspace_id":"workspace-A"}'
    );
    expect(JSON.parse(raw)).toMatchObject({
      tenant_id: "tenant-a",
      component: "dust-front",
      attempt_id: "attempt-1",
      input_tokens: "12",
      output_tokens: "5",
      cache_read_tokens: "2",
      quantity: "0",
    });
    expect(() =>
      buildFrontUsageEnvelope({
        attempt,
        providerOperationId: "vertex-operation-1",
        eventTime: new Date(),
        counts: { ...counts, outputTokens: undefined as never },
      })
    ).toThrow("metadata");
  });
});
