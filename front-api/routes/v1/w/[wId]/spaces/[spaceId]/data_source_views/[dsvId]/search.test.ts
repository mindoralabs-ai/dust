import { DataSourceViewFactory } from "@app/tests/utils/DataSourceViewFactory";
import { createPublicApiMockRequest } from "@app/tests/utils/generic_public_api_tests";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { CoreAPI } from "@app/types/core/core_api";
import { Err } from "@app/types/shared/result";
import { honoApp } from "@front-api/app";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("GET /api/v1/w/:wId/spaces/:spaceId/data_source_views/:dsvId/search", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      "quota_exceeded",
      429,
      "rate_limit_error",
      { code: "quota_exceeded", message: "Core refused the search" },
    ],
    ["internal_server_error", 400, "data_source_error", undefined],
  ])("answers Core's %s on a search with %i %s", async (coreCode, status, type, dataSourceError) => {
    const { workspace, key } = await createPublicApiMockRequest();
    const space = await SpaceFactory.global(workspace);
    const dataSourceView = await DataSourceViewFactory.folder(workspace, space);
    const searchSpy = vi
      .spyOn(CoreAPI.prototype, "searchDataSource")
      .mockResolvedValue(
        new Err({ code: coreCode, message: "Core refused the search" })
      );

    const response = await honoApp.request(
      `/api/v1/w/${workspace.sId}/spaces/${space.sId}/data_source_views/${dataSourceView.sId}/search?query=hello&top_k=5&full_text=false`,
      { headers: { authorization: `Bearer ${key.secret}` } }
    );

    expect(response.status).toBe(status);
    const { error } = await response.json();
    expect(error.type).toBe(type);
    expect(error.data_source_error).toEqual(dataSourceError);
    expect(searchSpy).toHaveBeenCalledOnce();
  });
});
