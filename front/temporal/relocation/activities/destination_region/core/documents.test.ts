import { processDataSourceDocuments } from "@app/temporal/relocation/activities/destination_region/core/documents";
import type { CoreDocumentAPIRelocationBlob } from "@app/temporal/relocation/activities/types";
import {
  deleteFromRelocationStorage,
  readFromRelocationStorage,
} from "@app/temporal/relocation/lib/file_storage/relocation";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import { CoreAPI, EMBEDDING_CONFIGS } from "@app/types/core/core_api";
import type { CoreAPIDataSource } from "@app/types/core/data_source";
import { DEFAULT_QDRANT_CLUSTER } from "@app/types/core/data_source";
import { Ok } from "@app/types/shared/result";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/temporal/relocation/lib/file_storage/relocation", () => ({
  deleteFromRelocationStorage: vi.fn(),
  readFromRelocationStorage: vi.fn(),
}));

const DEST_IDS = {
  dustAPIProjectId: "42",
  dustAPIDataSourceId: "destination-data-source",
};
const DATA_PATH = "relocations/w/core/documents/1.json";

function destinationCoreDataSource(
  embedder: "vertex_ai" | "openai"
): CoreAPIDataSource {
  return {
    created: Date.now(),
    data_source_id: DEST_IDS.dustAPIDataSourceId,
    data_source_internal_id: "internal-destination-data-source",
    name: "Relocated data source",
    config: {
      embedder_config: { embedder: EMBEDDING_CONFIGS[embedder] },
      qdrant_config: {
        cluster: DEFAULT_QDRANT_CLUSTER,
        shadow_write_cluster: null,
      },
    },
  };
}

function relocatedDocuments(): CoreDocumentAPIRelocationBlob {
  return {
    blobs: {
      documents: ["doc-1", "doc-2"].map((documentId) => ({
        document_id: documentId,
        timestamp: Date.now(),
        tags: [],
        parent_id: null,
        parents: [documentId],
        source_url: null,
        section: { prefix: null, content: "hello", sections: [] },
        title: documentId,
        mime_type: "text/plain",
        provider_visibility: null,
      })),
    },
  };
}

function mockCoreRelocation(embedder: "vertex_ai" | "openai") {
  const dataSource = destinationCoreDataSource(embedder);
  vi.mocked(readFromRelocationStorage).mockResolvedValue(relocatedDocuments());

  return {
    getDataSource: vi
      .spyOn(CoreAPI.prototype, "getDataSource")
      .mockResolvedValue(new Ok({ data_source: dataSource })),
    upsertDataSourceDocument: vi
      .spyOn(CoreAPI.prototype, "upsertDataSourceDocument")
      .mockResolvedValue(
        new Ok({
          document: {
            hash: "hash",
            text_size: 5,
            chunk_count: 1,
            token_count: 1,
            created: Date.now(),
          },
          data_source: dataSource,
        })
      ),
  };
}

function processDocuments(workspaceId: string) {
  return processDataSourceDocuments({
    destIds: DEST_IDS,
    dataPath: DATA_PATH,
    destRegion: "europe-west1",
    sourceRegion: "us-central1",
    sourceRegionApiBaseUrl: "https://dust.tt",
    workspaceId,
  });
}

describe("processDataSourceDocuments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(deleteFromRelocationStorage).mockClear();
  });

  it("copies a Vertex data source's documents for a BYOK workspace without an OpenAI embedding key", async () => {
    const workspace = await WorkspaceFactory.byok();
    const spies = mockCoreRelocation("vertex_ai");

    await processDocuments(workspace.sId);

    expect(spies.getDataSource).toHaveBeenCalledWith({
      projectId: DEST_IDS.dustAPIProjectId,
      dataSourceId: DEST_IDS.dustAPIDataSourceId,
    });
    expect(spies.upsertDataSourceDocument).toHaveBeenCalledTimes(2);
    for (const [upsert] of spies.upsertDataSourceDocument.mock.calls) {
      expect(upsert.projectId).toBe(DEST_IDS.dustAPIProjectId);
      expect(upsert.dataSourceId).toBe(DEST_IDS.dustAPIDataSourceId);
      expect(upsert.credentials).not.toHaveProperty("OPENAI_EMBEDDING_API_KEY");
    }
    expect(deleteFromRelocationStorage).toHaveBeenCalledWith(DATA_PATH);
  });

  it("requires an OpenAI embedding key to copy an OpenAI data source's documents for a BYOK workspace", async () => {
    const workspace = await WorkspaceFactory.byok();
    const spies = mockCoreRelocation("openai");

    await expect(processDocuments(workspace.sId)).rejects.toThrow(
      "[BYOK] This action requires OPENAI_EMBEDDING_API_KEY to be configured."
    );
    expect(spies.upsertDataSourceDocument).not.toHaveBeenCalled();
    expect(deleteFromRelocationStorage).not.toHaveBeenCalled();
  });
});
