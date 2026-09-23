import { readFile } from "node:fs/promises";
import path from "node:path";
import config from "@app/lib/api/config";
import {
  claimFrontUsageWork,
  completeFrontUsageClaim,
  markFrontUsageUnknown,
  newFrontUsageAttemptId,
  readFrontUsageHealth,
  settleFrontUsageExact,
  settleFrontUsageNoCharge,
  startFrontUsageAttempt,
} from "@app/lib/api/usage_journal";
import { frontSequelize } from "@app/lib/resources/storage";
import { DustUsageAttemptModel } from "@app/lib/resources/storage/models/dust_usage_attempt";
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
      await DustUsageAttemptModel.sync({ alter: true });
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
        markFrontUsageUnknown(second.attemptId, "same-provider-operation")
      ).rejects.toThrow();
      await expect(
        observer.query(
          'UPDATE "dust_usage_attempts" SET "state" = $1 WHERE "attemptId" = $2',
          ["exact", second.attemptId]
        )
      ).rejects.toThrow();
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
