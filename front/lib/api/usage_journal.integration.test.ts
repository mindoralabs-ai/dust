import { readFile } from "node:fs/promises";
import {
  claimFrontUsageWork,
  completeFrontUsageClaim,
  markFrontUsageUnknown,
  newFrontUsageAttemptId,
  settleFrontUsageExact,
  startFrontUsageAttempt,
} from "@app/lib/api/usage_journal";
import { frontSequelize } from "@app/lib/resources/storage";
import { DustUsageAttemptModel } from "@app/lib/resources/storage/models/dust_usage_attempt";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Run only against a disposable local database. The table is intentionally left
// in place so a container/database restart can verify recovery independently.
const enabled = process.env.DUST_USAGE_JOURNAL_INTEGRATION === "1";

describe.runIf(enabled)(
  "Front Dust usage journal PostgreSQL durability",
  () => {
    let observer: Client;

    beforeAll(async () => {
      const uri = process.env.FRONT_DATABASE_URI;
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
        new URL(
          "../../migrations/pre-deploy/20260923090000_create_dust_usage_journal.sql",
          import.meta.url
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
        routeId: "route-test-a",
      };
      expect(await startFrontUsageAttempt(attempt)).toBe("created");
      const persisted = await observer.query(
        'SELECT "state" FROM "dust_usage_attempts" WHERE "attemptId" = $1',
        [attempt.attemptId]
      );
      expect(persisted.rows[0].state).toBe("started");
      expect(await startFrontUsageAttempt(attempt)).toBe("duplicate");
      await expect(
        startFrontUsageAttempt({ ...attempt, tenantId: "tenant-test-b" })
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
        routeId: "route-test-b",
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
  }
);
