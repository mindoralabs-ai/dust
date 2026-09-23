import {
  buildFrontUsageEnvelope,
  claimFrontUsageWork,
  completeFrontUsageClaim,
  markFrontUsageUnknown,
  newFrontUsageAttemptId,
  settleFrontUsageExact,
  startFrontUsageAttempt,
} from "@app/lib/api/usage_journal";
import { frontSequelize } from "@app/lib/resources/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/resources/storage", () => ({
  frontSequelize: {
    transaction: vi.fn(),
    query: vi.fn(),
  },
}));

const attempt = {
  attemptId: "attempt-1",
  tenantId: "tenant-A",
  workspaceId: "workspace-A",
  conversationId: "conversation-1",
  model: "gemini-2.5-flash",
  routeId: "route-A",
};
const counts = {
  inputTokens: 12,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 0,
};
const queryMock = frontSequelize.query as unknown as ReturnType<typeof vi.fn>;
const transactionMock = frontSequelize.transaction as unknown as ReturnType<
  typeof vi.fn
>;

describe("Front Dust usage journal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transactionMock.mockImplementation(
      async (fn: (transaction: object) => Promise<unknown>) => fn({})
    );
  });

  it("creates stable distinct retry IDs", () => {
    expect(newFrontUsageAttemptId()).not.toBe(newFrontUsageAttemptId());
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
      '{"agent":"dust","attempt_id":"attempt-1","cache_read_tokens":"2","cache_write_tokens":"0","component":"dust-front","conversation_id":"conversation-1","event_type":"token","input_tokens":"12","model":"gemini-2.5-flash","output_tokens":"5","provider_operation_id":"vertex-operation-1","quantity":"0","tenant_id":"tenant-A","ts":"2026-09-23T09:00:00.000Z","workspace_id":"workspace-A"}'
    );
    expect(JSON.parse(raw)).toMatchObject({
      tenant_id: "tenant-A",
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

  it("commits a new started row before returning permission to dispatch", async () => {
    const calls: string[] = [];
    queryMock.mockImplementation(async (sql: string) => {
      calls.push(String(sql));
      return String(sql).startsWith("INSERT")
        ? [{ attemptId: attempt.attemptId }]
        : [];
    });
    await expect(startFrontUsageAttempt(attempt)).resolves.toBe("created");
    expect(calls[0]).toContain("synchronous_commit = on");
    expect(calls[1]).toContain("ON CONFLICT");
    expect(calls[1]).toContain("RETURNING");
  });

  it("returns duplicate rather than permitting a second provider dispatch", async () => {
    let digest = "";
    queryMock.mockImplementation(
      async (sql: string, options: { replacements: { digest: string } }) => {
        if (String(sql).startsWith("INSERT")) {
          digest ||= options.replacements.digest;
          return [];
        }
        if (String(sql).startsWith("SELECT")) {
          return [{ identityHash: digest }];
        }
        return [];
      }
    );
    await expect(startFrontUsageAttempt(attempt)).resolves.toBe("duplicate");
    await expect(
      startFrontUsageAttempt({ ...attempt, tenantId: "tenant-B" })
    ).rejects.toThrow("Conflicting");
  });

  it("never turns an exact settled attempt into unknown", async () => {
    queryMock.mockImplementation(async (sql: string) =>
      String(sql).startsWith("SELECT") ? [{ state: "exact" }] : []
    );
    await expect(markFrontUsageUnknown(attempt.attemptId)).rejects.toThrow(
      "Conflicting"
    );
  });

  it("rejects incomplete response usage before an exact settlement write", async () => {
    queryMock.mockImplementation(async (sql: string) =>
      String(sql).startsWith("SELECT")
        ? [
            {
              state: "started",
              identityHash: "bad-identity",
              createdAt: new Date(),
            },
          ]
        : []
    );
    await expect(
      settleFrontUsageExact({
        attempt,
        providerOperationId: "vertex-operation-1",
        counts: { ...counts, inputTokens: Number.NaN },
      })
    ).rejects.toThrow();
  });

  it("rejects an exact receipt for a different provider operation", async () => {
    let identityHash = "";
    queryMock.mockImplementation(
      async (sql: string, options: { replacements: { digest: string } }) => {
        if (sql.includes("INSERT INTO")) {
          identityHash = options.replacements.digest;
          return [{ attemptId: attempt.attemptId }];
        }
        if (sql.includes("FOR UPDATE")) {
          return [
            {
              state: "unknown",
              identityHash,
              providerOperationId: "original-operation",
              createdAt: new Date("2026-09-23T09:00:00.000Z"),
            },
          ];
        }
        return [];
      }
    );
    await startFrontUsageAttempt(attempt);
    await expect(
      settleFrontUsageExact({
        attempt,
        providerOperationId: "different-operation",
        counts,
      })
    ).rejects.toThrow("provider operation identity");
    expect(
      queryMock.mock.calls.some(([sql]) =>
        String(sql).includes("SET \"state\" = 'exact'")
      )
    ).toBe(false);
  });

  it("fences a reclaimed lease even when the worker owner name is reused", async () => {
    const claims: string[] = [];
    queryMock.mockImplementation(
      async (
        sql: string,
        options: { replacements?: Record<string, string> }
      ) => {
        if (sql.includes("RETURNING j.")) {
          claims.push(options.replacements?.leaseNonce ?? "");
          return [
            {
              attemptId: attempt.attemptId,
              leaseOwner: "worker-a",
              leaseNonce: options.replacements?.leaseNonce,
            },
          ];
        }
        if (sql.includes('AND "leaseNonce"')) {
          return options.replacements?.leaseNonce === claims[1]
            ? [{ attemptId: attempt.attemptId }]
            : [];
        }
        return [];
      }
    );
    const first = (await claimFrontUsageWork("worker-a"))[0];
    const reclaimed = (await claimFrontUsageWork("worker-a"))[0];
    expect(first.leaseNonce).not.toBe(reclaimed.leaseNonce);
    await expect(
      completeFrontUsageClaim({
        attemptId: first.attemptId,
        leaseOwner: first.leaseOwner,
        leaseNonce: first.leaseNonce,
        delivered: true,
      })
    ).rejects.toThrow("lease was lost");
    await expect(
      completeFrontUsageClaim({
        attemptId: reclaimed.attemptId,
        leaseOwner: reclaimed.leaseOwner,
        leaseNonce: reclaimed.leaseNonce,
        delivered: true,
      })
    ).resolves.toBeUndefined();
  });
});
