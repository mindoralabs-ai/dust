import { getAvailableModelsForWorkspace } from "@app/lib/api/assistant/workspace_capabilities";
import { Authenticator } from "@app/lib/auth";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import { MODEL_STREAM_IDS } from "@app/types/assistant/models/auto";
import { GEMINI_3_7_FLASH_MODEL_ID } from "@app/types/assistant/models/google_ai_studio";
import { afterEach, describe, expect, it, vi } from "vitest";

// The POC mode is cached once read as "1", so the lock-off case runs first.
describe("getAvailableModelsForWorkspace", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("offers the catalog with its stream meta-models outside the isolated POC", async () => {
    const workspace = await WorkspaceFactory.basic();
    const auth = await Authenticator.internalAdminForWorkspace(workspace.sId);

    const models = await getAvailableModelsForWorkspace(auth);
    const modelIds = models.map((m) => m.modelId);

    expect(modelIds).toEqual(expect.arrayContaining([...MODEL_STREAM_IDS]));
    expect(models.some((m) => m.providerId === "openai")).toBe(true);
    expect(models.some((m) => m.providerId === "anthropic")).toBe(true);
  });

  it("offers only Gemini 3.7 Flash, without streams, in the isolated POC", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    const workspace = await WorkspaceFactory.basic();
    const auth = await Authenticator.internalAdminForWorkspace(workspace.sId);

    const models = await getAvailableModelsForWorkspace(auth);

    expect(models.map((m) => [m.providerId, m.modelId])).toEqual([
      ["google_ai_studio", GEMINI_3_7_FLASH_MODEL_ID],
    ]);
  });

  it("offers nothing in the isolated POC when the workspace excludes Google", async () => {
    vi.stubEnv("DUST_POC_MODE", "1");
    const workspace = await WorkspaceFactory.basic({
      whiteListedProviders: ["openai", "anthropic"],
    });
    const auth = await Authenticator.internalAdminForWorkspace(workspace.sId);

    expect(await getAvailableModelsForWorkspace(auth)).toEqual([]);
  });
});
