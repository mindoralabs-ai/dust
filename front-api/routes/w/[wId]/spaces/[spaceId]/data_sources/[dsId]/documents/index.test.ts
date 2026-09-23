import { upsertDocument } from "@app/lib/api/data_sources";
import { DustError } from "@app/lib/error";
import { DataSourceViewFactory } from "@app/tests/utils/DataSourceViewFactory";
import { createPrivateApiMockRequest } from "@app/tests/utils/generic_private_api_tests";
import { Err } from "@app/types/shared/result";
import { honoApp } from "@front-api/app";
import { expect, it, vi } from "vitest";

vi.mock(import("@app/lib/api/data_sources"), async (importOriginal) => ({
  ...(await importOriginal()),
  upsertDocument: vi.fn(),
}));

it.each([
  "POST",
  "PATCH",
])("returns 409 for an ambiguous %s document upsert", async (method) => {
  const { workspace, globalSpace } = await createPrivateApiMockRequest({
    role: "admin",
  });
  const view = await DataSourceViewFactory.folder(workspace, globalSpace);
  vi.mocked(upsertDocument).mockResolvedValue(
    new Err(
      new DustError(
        "ambiguous_provider_effect",
        "Check the document before trying again."
      )
    )
  );

  const base = `/api/w/${workspace.sId}/spaces/${globalSpace.sId}/data_sources/${view.dataSource.sId}/documents`;
  const response = await honoApp.request(
    method === "POST" ? base : `${base}/doc-1`,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Document",
        mime_type: "text/plain",
        text: "hello",
      }),
    }
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { type: "data_source_error" },
  });
  expect(upsertDocument).toHaveBeenCalledOnce();
  vi.mocked(upsertDocument).mockReset();
});
