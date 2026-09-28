-- Direct POC mode counts a workspace's unsettled attempts for the current UTC
-- day before every provider request, and never reconciles its own rows.
CREATE INDEX CONCURRENTLY "dust_usage_attempts_tenant_workspace_unsettled_idx" ON "dust_usage_attempts" ("tenantId", "workspaceId", "createdAt") WHERE "state" IN ('started', 'unknown');
