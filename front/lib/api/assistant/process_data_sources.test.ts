import { processDataSources } from "@app/lib/api/assistant/process_data_sources";
import { EMBEDDING_QUOTA_EXCEEDED_MESSAGE } from "@app/lib/api/embedding_quota";
import { DustError } from "@app/lib/error";
import { DataSourceViewFactory } from "@app/tests/utils/DataSourceViewFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { getTestStreamEndpoint } from "@app/tests/utils/models";
import { CoreAPI } from "@app/types/core/core_api";
import { Err } from "@app/types/shared/result";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("processDataSources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["quota_exceeded", true, EMBEDDING_QUOTA_EXCEEDED_MESSAGE],
    [
      "internal_server_error",
      false,
      "Failed to retrieve documents: Core refused the search",
    ],
  ])("maps Core's %s search error", async (coreCode, isQuotaError, message) => {
    const { authenticator, workspace, globalSpace } = await createResourceTest({
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
    const filter = { tags: null, parents: null, timestamp: null };

    const result = await processDataSources({
      auth: authenticator,
      coreDataSourceSearchCriterias: [
        {
          projectId: dataSource.dustAPIProjectId,
          dataSourceId: dataSource.dustAPIDataSourceId,
          filter,
          view_filter: filter,
        },
      ],
      modelInfo: { endpoint: getTestStreamEndpoint("gpt-5"), temperature: 0 },
      prompt: "prompt",
      objective: "Extract people names.",
      jsonSchema: { type: "object" },
      topK: 8,
    });

    expect(result.isErr() && result.error.message).toBe(message);
    expect(
      result.isErr() &&
        result.error instanceof DustError &&
        result.error.code === "quota_exceeded"
    ).toBe(isQuotaError);
    expect(searchSpy).toHaveBeenCalledOnce();
  });
});
