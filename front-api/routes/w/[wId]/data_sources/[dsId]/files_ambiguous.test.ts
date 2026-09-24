import { processAndUpsertToDataSource } from "@app/lib/api/files/upsert";
import { DustError } from "@app/lib/error";
import { DataSourceViewFactory } from "@app/tests/utils/DataSourceViewFactory";
import { FileFactory } from "@app/tests/utils/FileFactory";
import { createPrivateApiMockRequest } from "@app/tests/utils/generic_private_api_tests";
import { Err } from "@app/types/shared/result";
import { honoApp } from "@front-api/app";
import { expect, it, vi } from "vitest";

vi.mock(import("@app/lib/api/files/upsert"), async (importOriginal) => ({
  ...(await importOriginal()),
  processAndUpsertToDataSource: vi.fn(),
}));

it("returns 409 when a file document upsert has an ambiguous provider effect", async () => {
  const { auth, workspace, user, globalSpace } =
    await createPrivateApiMockRequest({ role: "admin" });
  const view = await DataSourceViewFactory.folder(workspace, globalSpace);
  const file = await FileFactory.csv(auth, user, {
    useCase: "upsert_document",
  });
  vi.mocked(processAndUpsertToDataSource).mockResolvedValue(
    new Err(
      new DustError(
        "ambiguous_provider_effect",
        "Check the document before trying again."
      )
    )
  );

  const response = await honoApp.request(
    `/api/w/${workspace.sId}/data_sources/${view.dataSource.sId}/files`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: file.sId }),
    }
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { type: "data_source_error" },
  });
  expect(processAndUpsertToDataSource).toHaveBeenCalledOnce();
});
