import { createCoreWorkspaceAssertion } from "@app/lib/api/core_workspace_assertion";
import type { Authenticator } from "@app/lib/auth";
import { DataSourceResource } from "@app/lib/resources/data_source_resource";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/resources/data_source_resource", () => ({
  DataSourceResource: { fetchByDustAPIDataSourceIds: vi.fn() },
}));

const secret = "a-long-enough-test-secret-for-workspace-assertions";
const auth = {
  getNonNullableWorkspace: () => ({ id: 7, sId: "w-test" }),
} as unknown as Authenticator;

describe("Core workspace assertion", () => {
  beforeEach(() => {
    process.env.DUST_CORE_WORKSPACE_ASSERTION_SECRET = secret;
    vi.mocked(DataSourceResource.fetchByDustAPIDataSourceIds).mockResolvedValue(
      [
        {
          workspaceId: 7,
          dustAPIProjectId: "11",
          dustAPIDataSourceId: "source-a",
        },
        {
          workspaceId: 7,
          dustAPIProjectId: "12",
          dustAPIDataSourceId: "source-b",
        },
      ] as never
    );
  });

  afterEach(() => {
    delete process.env.DUST_CORE_WORKSPACE_ASSERTION_SECRET;
    vi.clearAllMocks();
  });

  it("signs only authenticated exact Core pairs", async () => {
    const token = await createCoreWorkspaceAssertion(auth, [
      { projectId: "11", dataSourceId: "source-a" },
      { projectId: "12", dataSourceId: "source-b" },
    ]);
    expect(
      jwt.verify(token!, secret, {
        audience: "dust-core-vertex-embedding",
        algorithms: ["HS256"],
      })
    ).toMatchObject({
      workspace_sid: "w-test",
      data_sources: [
        { project_id: 11, data_source_id: "source-a" },
        { project_id: 12, data_source_id: "source-b" },
      ],
    });
  });

  it("rejects a different project paired with an authorized data source", async () => {
    await expect(
      createCoreWorkspaceAssertion(auth, [
        { projectId: "12", dataSourceId: "source-a" },
      ])
    ).rejects.toThrow("not bound");
  });

  it("rejects a partial unauthorized bulk request", async () => {
    await expect(
      createCoreWorkspaceAssertion(auth, [
        { projectId: "11", dataSourceId: "source-a" },
        { projectId: "13", dataSourceId: "other-tenant-source" },
      ])
    ).rejects.toThrow("not bound");
  });

  it("signs a repeated authorized Core pair once", async () => {
    const token = await createCoreWorkspaceAssertion(auth, [
      { projectId: "11", dataSourceId: "source-a" },
      { projectId: "11", dataSourceId: "source-a" },
    ]);
    expect(
      jwt.verify(token!, secret, {
        audience: "dust-core-vertex-embedding",
        algorithms: ["HS256"],
      })
    ).toMatchObject({
      data_sources: [{ project_id: 11, data_source_id: "source-a" }],
    });
  });
});
