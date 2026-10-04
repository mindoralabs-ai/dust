import { getDataSourceURI } from "@app/lib/actions/mcp_internal_actions/input_configuration";
import type { ToolRunContext } from "@app/lib/actions/types";
import { search } from "@app/lib/api/actions/servers/data_sources_file_system/tools/search";
import { EMBEDDING_QUOTA_EXCEEDED_MESSAGE } from "@app/lib/api/embedding_quota";
import { DataSourceViewFactory } from "@app/tests/utils/DataSourceViewFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { CoreAPI } from "@app/types/core/core_api";
import { Err } from "@app/types/shared/result";
import { INTERNAL_MIME_TYPES } from "@dust-tt/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// The search only reads the step's retrieval budget from the run context.
const runContext = {
  contextType: "agent_loop",
  stepContext: { retrievalTopK: 5, citationsOffset: 0 },
} as unknown as ToolRunContext;

describe("data_sources_file_system search", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["quota_exceeded", EMBEDDING_QUOTA_EXCEEDED_MESSAGE, false],
    [
      "internal_server_error",
      "Failed to search content: Core refused the search",
      true,
    ],
  ])("returns a tool error when Core answers %s", async (coreCode, message, tracked) => {
    const { authenticator, workspace, globalSpace } = await createResourceTest({
      role: "admin",
    });
    const view = await DataSourceViewFactory.folder(workspace, globalSpace);
    const searchSpy = vi
      .spyOn(CoreAPI.prototype, "bulkSearchDataSources")
      .mockResolvedValue(
        new Err({ code: coreCode, message: "Core refused the search" })
      );

    const result = await search(
      {
        query: "pricing",
        relativeTimeFrame: "all",
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
      },
      { auth: authenticator, runContext }
    );

    expect(result.isErr() && result.error).toMatchObject({ message, tracked });
    expect(searchSpy).toHaveBeenCalledOnce();
  });
});
