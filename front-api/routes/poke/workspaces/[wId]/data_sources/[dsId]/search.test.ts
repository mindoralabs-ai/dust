import { DataSourceViewFactory } from "@app/tests/utils/DataSourceViewFactory";
import { createPokeApiMockRequest } from "@app/tests/utils/generic_poke_api_tests";
import { CoreAPI } from "@app/types/core/core_api";
import { Err } from "@app/types/shared/result";
import { honoApp } from "@front-api/app";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("GET /api/poke/workspaces/:wId/data_sources/:dsId/search", () => {
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
    const { workspace, globalSpace } = await createPokeApiMockRequest({
      isSuperUser: true,
      role: "admin",
    });
    const { dataSource } = await DataSourceViewFactory.folder(
      workspace,
      globalSpace
    );
    const searchSpy = vi
      .spyOn(CoreAPI.prototype, "searchDataSource")
      .mockResolvedValue(
        new Err({ code: coreCode, message: "Core refused the search" })
      );

    const response = await honoApp.request(
      `/api/poke/workspaces/${workspace.sId}/data_sources/${dataSource.sId}/search?query=hello&top_k=5&full_text=false`
    );

    expect(response.status).toBe(status);
    const { error } = await response.json();
    expect(error.type).toBe(type);
    expect(error.data_source_error).toEqual(dataSourceError);
    expect(searchSpy).toHaveBeenCalledOnce();
  });
});
