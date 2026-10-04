import { createDataSourceProject } from "@app/temporal/relocation/activities/destination_region/core/data_sources";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import { CoreAPI, EMBEDDING_CONFIGS } from "@app/types/core/core_api";
import type { CoreAPIDataSource } from "@app/types/core/data_source";
import { DEFAULT_QDRANT_CLUSTER } from "@app/types/core/data_source";
import { Ok } from "@app/types/shared/result";
import { afterEach, describe, expect, it, vi } from "vitest";

function sourceRegionCoreDataSource(
  embedder: "vertex_ai" | "openai"
): CoreAPIDataSource {
  return {
    created: Date.now(),
    data_source_id: `source-${embedder}`,
    data_source_internal_id: `internal-source-${embedder}`,
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

function mockCoreCreation() {
  return {
    createProject: vi
      .spyOn(CoreAPI.prototype, "createProject")
      .mockResolvedValue(new Ok({ project: { project_id: 42 } })),
    createDataSource: vi
      .spyOn(CoreAPI.prototype, "createDataSource")
      .mockImplementation(
        async ({ config, name }) =>
          new Ok({
            data_source: {
              created: Date.now(),
              data_source_id: "destination-data-source",
              data_source_internal_id: "internal-destination-data-source",
              name,
              config,
            },
          })
      ),
  };
}

describe("createDataSourceProject", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("relocates a Vertex data source of a BYOK workspace without an OpenAI embedding key", async () => {
    const workspace = await WorkspaceFactory.byok();
    const spies = mockCoreCreation();

    const result = await createDataSourceProject({
      destRegion: "europe-west1",
      sourceRegionCoreDataSource: sourceRegionCoreDataSource("vertex_ai"),
      workspaceId: workspace.sId,
    });

    expect(result).toEqual({
      dustAPIProjectId: "42",
      dustAPIDataSourceId: "destination-data-source",
    });
    expect(spies.createDataSource).toHaveBeenCalledOnce();
    const { config, credentials } = spies.createDataSource.mock.calls[0][0];
    expect(config.embedder_config.embedder.provider_id).toBe("vertex_ai");
    expect(credentials).not.toHaveProperty("OPENAI_EMBEDDING_API_KEY");
  });

  it("requires an OpenAI embedding key to relocate an OpenAI data source of a BYOK workspace", async () => {
    const workspace = await WorkspaceFactory.byok();
    const spies = mockCoreCreation();

    await expect(
      createDataSourceProject({
        destRegion: "europe-west1",
        sourceRegionCoreDataSource: sourceRegionCoreDataSource("openai"),
        workspaceId: workspace.sId,
      })
    ).rejects.toThrow(
      "[BYOK] This action requires OPENAI_EMBEDDING_API_KEY to be configured."
    );
    expect(spies.createDataSource).not.toHaveBeenCalled();
  });
});
