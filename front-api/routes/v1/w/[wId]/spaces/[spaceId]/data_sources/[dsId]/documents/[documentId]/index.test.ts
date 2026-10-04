import { DataSourceViewFactory } from "@app/tests/utils/DataSourceViewFactory";
import { createPublicApiMockRequest } from "@app/tests/utils/generic_public_api_tests";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { CoreAPI } from "@app/types/core/core_api";
import { Err, Ok } from "@app/types/shared/result";
import { honoApp } from "@front-api/app";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("POST /api/v1/w/:wId/spaces/:spaceId/data_sources/:dsId/documents/:documentId", () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) {
      spy.mockRestore();
    }
  });

  it.each([
    ["quota_exceeded", 429, "rate_limit_error"],
    ["internal_server_error", 500, "internal_server_error"],
  ])("answers Core's %s on a sync upsert with %i %s", async (coreCode, status, type) => {
    const { workspace, key } = await createPublicApiMockRequest({
      method: "POST",
    });
    const space = await SpaceFactory.global(workspace);
    const { dataSource } = await DataSourceViewFactory.folder(workspace, space);
    const upsertSpy = vi
      .spyOn(CoreAPI.prototype, "upsertDataSourceDocument")
      .mockResolvedValue(
        new Err({ code: coreCode, message: "Core refused the upsert" })
      );
    spies.push(
      upsertSpy,
      vi
        .spyOn(CoreAPI.prototype, "getDataSourceStats")
        .mockResolvedValue(new Ok({ overall_total_size: 0, data_sources: [] }))
    );

    const response = await honoApp.request(
      `/api/v1/w/${workspace.sId}/spaces/${space.sId}/data_sources/${dataSource.sId}/documents/doc-1`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Document",
          mime_type: "text/plain",
          text: "hello",
        }),
      }
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      error: { type, data_source_error: { code: coreCode } },
    });
    expect(upsertSpy).toHaveBeenCalledOnce();
  });
});
