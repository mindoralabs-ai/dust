import { internalFetch } from "@app/lib/api/internal_fetch";
import type { CoreAPIError } from "@app/types/core/core_api";
import { CoreAPI } from "@app/types/core/core_api";
import { Err } from "@app/types/shared/result";
import { afterEach, describe, expect, it, vi } from "vitest";

const QUOTA: CoreAPIError = {
  code: "quota_exceeded",
  message: "Dust token quota exceeded",
};
const INTERNAL: CoreAPIError = {
  code: "internal_server_error",
  message: "Failed to perform the search",
};
const OTHER: CoreAPIError = {
  code: "search_failed",
  message: "Search failed",
};

function makeCoreAPI() {
  return new CoreAPI(
    { url: "http://fake-core-api", apiKey: null },
    { error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn() }
  );
}

function makeSearches(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    projectId: "1",
    dataSourceId: `ds-${i}`,
    view_filter: { tags: null, parents: null, timestamp: null },
  }));
}

describe("CoreAPI search aggregation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(internalFetch).mockReset();
  });

  // The quota denial comes second: returning the first error would hide it.
  it.each([
    [[INTERNAL, QUOTA], QUOTA],
    [[INTERNAL, OTHER], INTERNAL],
  ])("searchDataSources answers %j with %j", async (errors, expected) => {
    vi.spyOn(CoreAPI.prototype, "searchDataSource").mockImplementation(
      async (_projectId, dataSourceId) =>
        new Err(errors[Number(dataSourceId.replace("ds-", ""))])
    );

    const result = await makeCoreAPI().searchDataSources(
      "query",
      5,
      {},
      false,
      makeSearches(2)
    );

    expect(result.isErr() && result.error).toEqual(expected);
  });

  // Bulk search sends 100 data sources per Core request, so 101 make two requests.
  it.each([
    [[INTERNAL, QUOTA], QUOTA],
    [[INTERNAL, OTHER], INTERNAL],
  ])("bulkSearchDataSources answers %j with %j", async (errors, expected) => {
    vi.mocked(internalFetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const error = body.searches.length === 100 ? errors[0] : errors[1];
      return new Response(JSON.stringify({ error, response: null }), {
        status: error === QUOTA ? 429 : 500,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await makeCoreAPI().bulkSearchDataSources(
      "query",
      5,
      {},
      false,
      makeSearches(101)
    );

    expect(result.isErr() && result.error).toEqual(expected);
    expect(internalFetch).toHaveBeenCalledTimes(2);
  });
});
