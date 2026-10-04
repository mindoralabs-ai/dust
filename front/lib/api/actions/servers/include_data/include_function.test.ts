import { getDataSourceURI } from "@app/lib/actions/mcp_internal_actions/input_configuration";
import { runIncludeDataRetrieval } from "@app/lib/api/actions/servers/include_data/include_function";
import { EMBEDDING_QUOTA_EXCEEDED_MESSAGE } from "@app/lib/api/embedding_quota";
import { DataSourceViewFactory } from "@app/tests/utils/DataSourceViewFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { CoreAPI } from "@app/types/core/core_api";
import { Err } from "@app/types/shared/result";
import { INTERNAL_MIME_TYPES } from "@dust-tt/client";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("runIncludeDataRetrieval", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["quota_exceeded", EMBEDDING_QUOTA_EXCEEDED_MESSAGE, false],
    ["internal_server_error", "Core refused the search", true],
  ])("returns a tool error when Core answers %s", async (coreCode, message, tracked) => {
    const { authenticator, workspace, globalSpace } = await createResourceTest({
      role: "admin",
    });
    const view = await DataSourceViewFactory.folder(workspace, globalSpace);
    const searchSpy = vi
      .spyOn(CoreAPI.prototype, "searchDataSource")
      .mockResolvedValue(
        new Err({ code: coreCode, message: "Core refused the search" })
      );

    const result = await runIncludeDataRetrieval(authenticator, {
      citationsOffset: 0,
      retrievalTopK: 8,
      dataSources: [
        {
          uri: getDataSourceURI({
            workspaceId: workspace.sId,
            dataSourceViewId: view.sId,
            filter: { parents: null, tags: null },
          }),
          mimeType: INTERNAL_MIME_TYPES.TOOL_INPUT.DATA_SOURCE,
        },
      ],
    });

    expect(result.isErr() && result.error).toMatchObject({ message, tracked });
    expect(searchSpy).toHaveBeenCalledOnce();
  });
});
