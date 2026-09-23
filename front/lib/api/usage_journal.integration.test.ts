import { readFile } from "node:fs/promises";
import path from "node:path";
import config from "@app/lib/api/config";
import {
  claimFrontUsageWork,
  completeFrontUsageClaim,
  consumeFrontUsageStartPermit,
  markFrontUsageUnknown,
  newFrontUsageAttemptId,
  readFrontUsageHealth,
  settleFrontUsageExact,
  settleFrontUsageNoCharge,
  startFrontUsageAttempt,
  startFrontUsageAttemptForAdmission,
  validateFrontUsageClaim,
} from "@app/lib/api/usage_journal";
import { frontSequelize } from "@app/lib/resources/storage";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Run only against a disposable local database. The table is intentionally left
// in place so a container/database restart can verify recovery independently.
const enabled = config.isDustUsageJournalIntegrationTestEnabled();

describe.runIf(enabled)(
  "Front Dust usage journal PostgreSQL durability",
  () => {
    let observer: Client;

    beforeAll(async () => {
      const uri = config.getFrontDatabaseUriForTest();
      if (!uri) {
        throw new Error("A disposable journal test database URI is required");
      }
      const target = new URL(uri);
      if (
        target.hostname !== "127.0.0.1" ||
        target.pathname !== "/dust_journal_test"
      ) {
        throw new Error("Refusing to alter a non-disposable database");
      }
      observer = new Client({ connectionString: uri });
      await observer.connect();
      await observer.query('DROP TABLE IF EXISTS "dust_usage_attempts"');
      const migration = await readFile(
        path.resolve(
          process.cwd(),
          "migrations/pre-deploy/20260923090000_create_dust_usage_journal.sql"
        ),
        "utf8"
      );
      await observer.query(migration);
    });

    afterAll(async () => {
      await observer?.end();
      await frontSequelize.close();
    });

    it("commits attempts before dispatch, preserves frozen outbox bytes, and idempotently delivers", async () => {
      const attempt = {
        attemptId: newFrontUsageAttemptId(),
        tenantId: "tenant-test-a",
        workspaceId: "workspace-test-a",
        conversationId: "conversation-test-a",
        model: "gemini-2.5-flash",
        routeId: "tenant-test-a:7",
      };
      expect(await startFrontUsageAttempt(attempt)).toBe("created");
      const persisted = await observer.query(
        'SELECT "state" FROM "dust_usage_attempts" WHERE "attemptId" = $1',
        [attempt.attemptId]
      );
      expect(persisted.rows[0].state).toBe("started");
      expect(await startFrontUsageAttempt(attempt)).toBe("duplicate");
      await expect(
        startFrontUsageAttempt({
          ...attempt,
          tenantId: "tenant-test-b",
          routeId: "tenant-test-b:7",
        })
      ).rejects.toThrow("Conflicting");

      await markFrontUsageUnknown(attempt.attemptId, "vertex-operation-test");
      const frozen = await settleFrontUsageExact({
        attempt,
        providerOperationId: "vertex-operation-test",
        counts: {
          inputTokens: 9,
          outputTokens: 3,
          cacheReadTokens: 1,
          cacheWriteTokens: 0,
        },
      });
      expect(JSON.parse(frozen)).toMatchObject({
        tenant_id: "tenant-test-a",
        component: "dust-front",
        attempt_id: attempt.attemptId,
        input_tokens: "9",
      });
      const claimed = await claimFrontUsageWork("worker-test-a");
      const work = claimed.find((item) => item.attemptId === attempt.attemptId);
      expect(work?.tenantId).toBe(attempt.tenantId);
      expect(work?.routeId).toBe(attempt.routeId);
      expect(work?.eventEnvelope).toBe(frozen);
      expect(
        claimed.filter((item) => item.attemptId === attempt.attemptId)
      ).toHaveLength(1);
      expect(work).toBeDefined();
      if (!work) {
        throw new Error("Missing claimed test row");
      }
      await expect(validateFrontUsageClaim(work)).resolves.toBeUndefined();
      await expect(
        validateFrontUsageClaim({ ...work, eventEnvelope: "fabricated" })
      ).rejects.toThrow("leased frozen row");
      await completeFrontUsageClaim({
        attemptId: attempt.attemptId,
        leaseOwner: "worker-test-a",
        leaseNonce: work?.leaseNonce ?? "",
        delivered: true,
      });
      const settled = await observer.query(
        'SELECT "state", "eventEnvelope", "deliveredAt" FROM "dust_usage_attempts" WHERE "attemptId" = $1',
        [attempt.attemptId]
      );
      expect(settled.rows[0].state).toBe("exact");
      expect(settled.rows[0].eventEnvelope).toBe(frozen);
      expect(settled.rows[0].deliveredAt).not.toBeNull();
      await expect(validateFrontUsageClaim(work)).rejects.toThrow(
        "leased frozen row"
      );
      await expect(markFrontUsageUnknown(attempt.attemptId)).rejects.toThrow(
        "Conflicting"
      );
    });

    it("issues one admission permit for the committed attempt only", async () => {
      const attempt = {
        attemptId: newFrontUsageAttemptId(),
        tenantId: "tenant-test-permit",
        workspaceId: "workspace-test-permit",
        conversationId: "conversation-test-permit",
        model: "gemini-2.5-flash",
        routeId: "tenant-test-permit:7",
      };
      const route = {
        tenantId: attempt.tenantId,
        workspaceId: attempt.workspaceId,
        revision: 7,
        admissionUrl: "https://crm.internal/internal/usage/dust/admission",
        frontCredentialRef: "/run/tenant-test-permit-front-key",
      } as import("@app/lib/api/tenant_route").TenantRoute;
      const permit = await startFrontUsageAttemptForAdmission(attempt, route);
      expect(permit).not.toBeNull();
      expect(
        consumeFrontUsageStartPermit(permit, "another-attempt", route)
      ).toBe(false);
      expect(
        consumeFrontUsageStartPermit(permit, attempt.attemptId, {
          ...route,
          tenantId: "tenant-other",
        })
      ).toBe(false);
      expect(
        consumeFrontUsageStartPermit(permit, attempt.attemptId, route)
      ).toBe(true);
      expect(
        consumeFrontUsageStartPermit(permit, attempt.attemptId, route)
      ).toBe(false);
      expect(
        await startFrontUsageAttemptForAdmission(attempt, route)
      ).toBeNull();
    });

    it("retains an unresolved attempt for recovery instead of inventing no-charge", async () => {
      const attemptId = newFrontUsageAttemptId();
      await startFrontUsageAttempt({
        attemptId,
        tenantId: "tenant-test-b",
        workspaceId: "workspace-test-b",
        conversationId: "conversation-test-b",
        model: "gemini-2.5-flash",
        routeId: "tenant-test-b:7",
      });
      await markFrontUsageUnknown(attemptId, "vertex-unresolved-test");
      const persisted = await observer.query(
        'SELECT "state", "providerOperationId", "firstUnresolvedAt" FROM "dust_usage_attempts" WHERE "attemptId" = $1',
        [attemptId]
      );
      expect(persisted.rows[0].state).toBe("unknown");
      expect(persisted.rows[0].providerOperationId).toBe(
        "vertex-unresolved-test"
      );
      expect(persisted.rows[0].firstUnresolvedAt).not.toBeNull();
    });

    it("rejects duplicate provider operations and exact rows without frozen bytes", async () => {
      const base = {
        tenantId: "tenant-test-a",
        workspaceId: "workspace-test-a",
        conversationId: "conversation-test-a",
        model: "gemini-2.5-flash",
        routeId: "tenant-test-a:7",
      };
      const first = { ...base, attemptId: newFrontUsageAttemptId() };
      const second = { ...base, attemptId: newFrontUsageAttemptId() };
      await startFrontUsageAttempt(first);
      await startFrontUsageAttempt(second);
      await markFrontUsageUnknown(first.attemptId, "same-provider-operation");
      await expect(
        settleFrontUsageExact({
          attempt: first,
          providerOperationId: "different-provider-operation",
          counts: {
            inputTokens: 2,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        })
      ).rejects.toThrow("provider operation identity");
      await expect(
        markFrontUsageUnknown(second.attemptId, "same-provider-operation")
      ).rejects.toThrow();
      await expect(
        observer.query(
          'UPDATE "dust_usage_attempts" SET "state" = $1 WHERE "attemptId" = $2',
          ["exact", second.attemptId]
        )
      ).rejects.toThrow();
    });

    it("fences a reclaimed claim even when the worker owner is reused", async () => {
      const attempt = {
        attemptId: newFrontUsageAttemptId(),
        tenantId: "tenant-test-reclaim",
        workspaceId: "workspace-test-reclaim",
        conversationId: "conversation-test-reclaim",
        model: "gemini-2.5-flash",
        routeId: "tenant-test-reclaim:7",
      };
      await startFrontUsageAttempt(attempt);
      await settleFrontUsageExact({
        attempt,
        providerOperationId: `vertex:${attempt.attemptId}`,
        counts: {
          inputTokens: 2,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
      const first = (
        await claimFrontUsageWork("worker-test-reclaim", 100)
      ).find((claim) => claim.attemptId === attempt.attemptId);
      if (!first) {
        throw new Error("Missing first claimed test row");
      }
      await observer.query(
        `UPDATE "dust_usage_attempts" SET "leaseUntil" = now() - interval '1 second',
         "nextRetryAt" = now() - interval '1 second' WHERE "attemptId" = $1`,
        [attempt.attemptId]
      );
      const reclaimed = (
        await claimFrontUsageWork("worker-test-reclaim", 100)
      ).find((claim) => claim.attemptId === attempt.attemptId);
      if (!reclaimed) {
        throw new Error("Missing reclaimed test row");
      }
      expect(reclaimed.leaseNonce).not.toBe(first.leaseNonce);
      await expect(
        completeFrontUsageClaim({
          attemptId: attempt.attemptId,
          leaseOwner: first.leaseOwner,
          leaseNonce: first.leaseNonce,
          delivered: true,
        })
      ).rejects.toThrow("lease was lost");
      await completeFrontUsageClaim({
        attemptId: attempt.attemptId,
        leaseOwner: reclaimed.leaseOwner,
        leaseNonce: reclaimed.leaseNonce,
        delivered: true,
      });
    });

    it("claims fresh exact usage ahead of repeatedly due older work", async () => {
      const base = {
        tenantId: "tenant-test-fairness",
        workspaceId: "workspace-test-fairness",
        conversationId: "conversation-test-fairness",
        model: "gemini-2.5-flash",
        routeId: "tenant-test-fairness:7",
      };
      const oldAttempts = [newFrontUsageAttemptId(), newFrontUsageAttemptId()];
      for (const attemptId of oldAttempts) {
        await startFrontUsageAttempt({ ...base, attemptId });
        await markFrontUsageUnknown(attemptId, `unknown:${attemptId}`);
        await observer.query(
          `UPDATE "dust_usage_attempts" SET "retryCount" = 3,
           "createdAt" = now() - interval '2 days',
           "nextRetryAt" = now() - interval '1 hour'
           WHERE "attemptId" = $1`,
          [attemptId]
        );
      }
      const fresh = { ...base, attemptId: newFrontUsageAttemptId() };
      await startFrontUsageAttempt(fresh);
      await settleFrontUsageExact({
        attempt: fresh,
        providerOperationId: `vertex:${fresh.attemptId}`,
        counts: {
          inputTokens: 2,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
      const claimed = (
        await claimFrontUsageWork("worker-test-fairness", 2)
      ).find((claim) => claim.attemptId === fresh.attemptId);
      if (!claimed) {
        throw new Error("Fresh exact usage was not claimed");
      }
      await completeFrontUsageClaim({
        attemptId: fresh.attemptId,
        leaseOwner: claimed.leaseOwner,
        leaseNonce: claimed.leaseNonce,
        delivered: true,
      });
      for (let index = 0; index < 4; index++) {
        const next = { ...base, attemptId: newFrontUsageAttemptId() };
        await startFrontUsageAttempt(next);
        await settleFrontUsageExact({
          attempt: next,
          providerOperationId: `vertex:fair:${next.attemptId}`,
          counts: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        });
      }
      const claims = await claimFrontUsageWork("worker-test-fairness-next", 3);
      expect(claims).toHaveLength(3);
      expect(
        claims.some((claim) => oldAttempts.includes(claim.attemptId))
      ).toBe(true);
      expect(claims.filter((claim) => claim.state === "exact")).toHaveLength(2);
    });

    it("reports tenant-local unresolved work and undelivered exact usage to CRM", async () => {
      const tenantId = "tenant-test-health";
      const base = {
        tenantId,
        workspaceId: "workspace-test-health",
        conversationId: "conversation-test-health",
        model: "gemini-3.7-flash",
        routeId: "tenant-test-health:7",
      };
      const unresolved = { ...base, attemptId: newFrontUsageAttemptId() };
      const exact = { ...base, attemptId: newFrontUsageAttemptId() };
      await startFrontUsageAttempt(unresolved);
      await startFrontUsageAttempt(exact);
      await settleFrontUsageExact({
        attempt: exact,
        providerOperationId: "vertex-test-health",
        counts: {
          inputTokens: 3,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
      const pending = await readFrontUsageHealth(tenantId);
      expect(pending.unresolvedCount).toBe(1);
      expect(pending.oldestDeliveryAtSeconds).toBeGreaterThan(0);
      expect(pending.checkedAtSeconds).toBeGreaterThanOrEqual(
        pending.oldestDeliveryAtSeconds
      );

      await settleFrontUsageNoCharge(
        unresolved.attemptId,
        `predispatch:test:${unresolved.attemptId}`
      );
      expect((await readFrontUsageHealth(tenantId)).unresolvedCount).toBe(0);
      const work = (await claimFrontUsageWork("worker-test-health")).find(
        (item) => item.attemptId === exact.attemptId
      );
      expect(work).toBeDefined();
      await completeFrontUsageClaim({
        attemptId: exact.attemptId,
        leaseOwner: "worker-test-health",
        leaseNonce: work?.leaseNonce ?? "",
        delivered: true,
      });
      expect(
        (await readFrontUsageHealth(tenantId)).oldestDeliveryAtSeconds
      ).toBe(0);
    });

    it("accepts revision zero and excludes exact rows placed under manual review", async () => {
      const attempt = {
        attemptId: newFrontUsageAttemptId(),
        tenantId: "tenant-test-zero",
        workspaceId: "workspace-test-zero",
        conversationId: "conversation-test-zero",
        model: "gemini-3.7-flash",
        routeId: "tenant-test-zero:0",
      };
      expect(await startFrontUsageAttempt(attempt)).toBe("created");
      await settleFrontUsageExact({
        attempt,
        providerOperationId: "vertex-test-zero",
        counts: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
      await observer.query(
        'UPDATE "dust_usage_attempts" SET "manualReviewRequired" = true WHERE "attemptId" = $1',
        [attempt.attemptId]
      );
      expect(
        (await claimFrontUsageWork("worker-test-zero")).some(
          (claim) => claim.attemptId === attempt.attemptId
        )
      ).toBe(false);
      await observer.query(
        `UPDATE "dust_usage_attempts" SET "firstUnresolvedAt" = now() - interval '25 hours'
         WHERE "attemptId" = $1`,
        [attempt.attemptId]
      );
      await settleFrontUsageExact({
        attempt,
        providerOperationId: "vertex-test-zero",
        counts: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
      const recovered = (await claimFrontUsageWork("worker-test-zero")).find(
        (claim) => claim.attemptId === attempt.attemptId
      );
      if (!recovered) {
        throw new Error("Recovered exact claim was not available");
      }
      expect(recovered.manualReviewRequired).toBe(false);
      await completeFrontUsageClaim({
        attemptId: attempt.attemptId,
        leaseOwner: recovered.leaseOwner,
        leaseNonce: recovered.leaseNonce,
        delivered: false,
      });
      const row = await observer.query(
        'SELECT "manualReviewRequired" FROM "dust_usage_attempts" WHERE "attemptId" = $1',
        [attempt.attemptId]
      );
      expect(row.rows[0].manualReviewRequired).toBe(false);
    });
  }
);
