import { createCoreWorkspaceAssertion } from "@app/lib/api/core_workspace_assertion";
import { Authenticator } from "@app/lib/auth";
import { DataSourceViewFactory } from "@app/tests/utils/DataSourceViewFactory";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const secret = "a-long-enough-test-secret-for-workspace-assertions";

describe("Core workspace assertion", () => {
  let auth: Authenticator;
  let sourceA: string;
  let sourceB: string;
  let otherTenantSource: string;
  let workspaceSId: string;

  beforeEach(async () => {
    process.env.DUST_CORE_WORKSPACE_ASSERTION_SECRET = secret;
    const workspace = await WorkspaceFactory.basic();
    workspaceSId = workspace.sId;
    auth = await Authenticator.internalAdminForWorkspace(workspace.sId);
    const space = await SpaceFactory.global(workspace);
    sourceA = (
      await DataSourceViewFactory.folder(workspace, space, undefined, {
        dustAPIProjectId: "11",
      })
    ).dataSource.dustAPIDataSourceId;
    sourceB = (
      await DataSourceViewFactory.folder(workspace, space, undefined, {
        dustAPIProjectId: "12",
      })
    ).dataSource.dustAPIDataSourceId;

    const otherWorkspace = await WorkspaceFactory.basic();
    const otherSpace = await SpaceFactory.global(otherWorkspace);
    otherTenantSource = (
      await DataSourceViewFactory.folder(
        otherWorkspace,
        otherSpace,
        undefined,
        { dustAPIProjectId: "13" }
      )
    ).dataSource.dustAPIDataSourceId;
  });

  afterEach(() => {
    delete process.env.DUST_CORE_WORKSPACE_ASSERTION_SECRET;
  });

  it("signs only authenticated exact Core pairs", async () => {
    const token = await createCoreWorkspaceAssertion(auth, [
      { projectId: "11", dataSourceId: sourceA },
      { projectId: "12", dataSourceId: sourceB },
    ]);
    expect(
      jwt.verify(token!, secret, {
        audience: "dust-core-vertex-embedding",
        algorithms: ["HS256"],
      })
    ).toMatchObject({
      workspace_sid: workspaceSId,
      data_sources: [
        { project_id: 11, data_source_id: sourceA },
        { project_id: 12, data_source_id: sourceB },
      ],
    });
  });

  it("rejects a different project paired with an authorized data source", async () => {
    await expect(
      createCoreWorkspaceAssertion(auth, [
        { projectId: "12", dataSourceId: sourceA },
      ])
    ).rejects.toThrow("not bound");
  });

  it("rejects a partial unauthorized bulk request from another workspace", async () => {
    await expect(
      createCoreWorkspaceAssertion(auth, [
        { projectId: "11", dataSourceId: sourceA },
        { projectId: "13", dataSourceId: otherTenantSource },
      ])
    ).rejects.toThrow("not bound");
  });

  it("signs a repeated authorized Core pair once", async () => {
    const token = await createCoreWorkspaceAssertion(auth, [
      { projectId: "11", dataSourceId: sourceA },
      { projectId: "11", dataSourceId: sourceA },
    ]);
    expect(
      jwt.verify(token!, secret, {
        audience: "dust-core-vertex-embedding",
        algorithms: ["HS256"],
      })
    ).toMatchObject({
      data_sources: [{ project_id: 11, data_source_id: sourceA }],
    });
  });
});
