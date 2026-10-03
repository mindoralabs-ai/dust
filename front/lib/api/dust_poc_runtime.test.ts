import {
  authorizeDirectDustGenerationAttempt,
  authorizeDustGenerationAttempt,
} from "@app/lib/api/dust_generation_gate";
import { DustTenantRouteResolver } from "@app/lib/api/tenant_route";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/dust_generation_gate", () => ({
  authorizeDirectDustGenerationAttempt: vi.fn(),
  authorizeDustGenerationAttempt: vi.fn(),
}));
vi.mock("@app/lib/api/tenant_route", () => ({
  DustTenantRouteResolver: vi.fn(
    class {
      start = vi.fn().mockResolvedValue(undefined);
      refresh = vi.fn().mockResolvedValue(undefined);
      resolve = vi.fn().mockReturnValue({ workspaceId: "workspace-a" });
      listActiveRoutesForMaintenance = vi
        .fn()
        .mockReturnValue([{ tenantId: "tenant-a" }, { tenantId: "tenant-b" }]);
    }
  ),
}));

const authorize = vi.mocked(authorizeDustGenerationAttempt);
const authorizeDirect = vi.mocked(authorizeDirectDustGenerationAttempt);
const Resolver = vi.mocked(DustTenantRouteResolver);
const identity = {
  workspaceId: "workspace-a",
  workosOrganizationId: "org-a",
  workosUserId: "workos-a",
  dustUserId: "dust-a",
};
const selection = {
  identity,
  conversationId: "conversation-a",
  modelId: "gemini-3.7-flash",
  providerHost: "agent-platform",
  providerId: "google_ai_studio",
  inferenceRegion: "global",
};

describe("isolated Dust POC generation selection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("DUST_POC_MODE", "1");
    vi.stubEnv("DUST_FRONT_VERTEX_PROVIDER_IO_ENABLED", "1");
    vi.stubEnv("DUST_FRONT_VERTEX_EMBEDDING_SELECTION_ENABLED", "1");
    vi.stubEnv("DUST_POC_WORKSPACE_IDS", "workspace-a,workspace-b");
    vi.stubEnv("DUST_FRONT_REGISTRY_MIN_REVISION", "1");
    vi.stubEnv("DUST_FRONT_REGISTRY_SIGNER_URL", "https://signer.internal");
    vi.stubEnv("DUST_FRONT_REGISTRY_EXPORT_KEY_FILE", "/run/key");
    vi.stubEnv("DUST_FRONT_REGISTRY_KEY_ID", "key-1");
    vi.stubEnv("DUST_FRONT_REGISTRY_PUBLIC_KEY_BASE64", "a".repeat(44));
    authorize.mockResolvedValue({
      attempt: { attemptId: "attempt-1" },
    } as never);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("selects only a configured workspace and server-selected model", async () => {
    const { authorizePocGeneration } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    await authorizePocGeneration(selection);
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        identity,
        conversationId: "conversation-a",
        model: "gemini-3.7-flash",
        pocEnabled: true,
      })
    );
    await expect(
      authorizePocGeneration({
        ...selection,
        identity: { ...identity, workspaceId: "workspace-c" },
      })
    ).rejects.toThrow("unavailable");
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["DUST_POC_MODE", "0"],
    ["DUST_FRONT_VERTEX_PROVIDER_IO_ENABLED", "0"],
    ["DUST_POC_WORKSPACE_IDS", "workspace-a,workspace-a"],
    ["DUST_FRONT_REGISTRY_MIN_REVISION", "0"],
  ])("fails closed for invalid %s", async (key, value) => {
    vi.stubEnv(key, value);
    const { authorizePocGeneration } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    await expect(authorizePocGeneration(selection)).rejects.toThrow();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("rejects a provider or model override before a route lookup", async () => {
    const { authorizePocGeneration } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    await expect(
      authorizePocGeneration({ ...selection, modelId: "gemini-2.5-flash" })
    ).rejects.toThrow("unavailable");
    await expect(
      authorizePocGeneration({ ...selection, providerHost: "google-ai-studio" })
    ).rejects.toThrow("unavailable");
    expect(Resolver).not.toHaveBeenCalled();
  });

  it("selects Vertex only for a signed POC workspace, leaving unrelated workspaces alone", async () => {
    const { selectPocEmbeddingProvider } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    expect(await selectPocEmbeddingProvider(identity, "workspace-a")).toBe(
      "vertex_ai"
    );
    expect(
      await selectPocEmbeddingProvider(
        { ...identity, workspaceId: "workspace-c" },
        "workspace-c"
      )
    ).toBeNull();
    expect(Resolver).toHaveBeenCalledTimes(1);
  });

  it("blocks POC data source selection if the embedding switch or membership is missing", async () => {
    const { selectPocEmbeddingProvider } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    await expect(
      selectPocEmbeddingProvider(null, "workspace-a")
    ).rejects.toThrow("unavailable");
    vi.stubEnv("DUST_FRONT_VERTEX_EMBEDDING_SELECTION_ENABLED", "0");
    vi.resetModules();
    const { selectPocEmbeddingProvider: selectWithDisabledEmbedding } =
      await import("@app/lib/api/dust_poc_runtime");
    await expect(
      selectWithDisabledEmbedding(identity, "workspace-a")
    ).rejects.toThrow("unavailable");
  });

  it("keeps non-POC embedding selection unchanged without signer configuration", async () => {
    vi.stubEnv("DUST_POC_MODE", "0");
    vi.stubEnv("DUST_POC_WORKSPACE_IDS", "");
    const { selectPocEmbeddingProvider } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    expect(
      await selectPocEmbeddingProvider(null, "other-workspace")
    ).toBeNull();
    expect(Resolver).not.toHaveBeenCalled();
  });

  it("does not initialize a signer for an unrelated workspace in POC mode", async () => {
    vi.stubEnv("DUST_FRONT_REGISTRY_SIGNER_URL", "");
    const { selectPocEmbeddingProvider } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    expect(
      await selectPocEmbeddingProvider(null, "other-workspace")
    ).toBeNull();
    expect(Resolver).not.toHaveBeenCalled();
  });

  it("refreshes the signed route before selecting both maintenance tenants", async () => {
    const { pocRoutesForMaintenance } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    expect(await pocRoutesForMaintenance()).toEqual([
      { tenantId: "tenant-a" },
      { tenantId: "tenant-b" },
    ]);
    const instance = Resolver.mock.results[0].value;
    expect(instance.refresh).toHaveBeenCalledTimes(1);
    expect(instance.listActiveRoutesForMaintenance).toHaveBeenCalledWith(
      new Set(["workspace-a", "workspace-b"])
    );
  });

  it("accepts overlapping current and next signer verifiers", async () => {
    vi.stubEnv("DUST_FRONT_REGISTRY_NEXT_KEY_ID", "key-2");
    vi.stubEnv("DUST_FRONT_REGISTRY_NEXT_PUBLIC_KEY_BASE64", "b".repeat(44));
    const { pocRoutesForMaintenance } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    await pocRoutesForMaintenance();
    expect(Resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        verifiers: [
          { keyId: "key-1", publicKeyBase64: "a".repeat(44) },
          { keyId: "key-2", publicKeyBase64: "b".repeat(44) },
        ],
      })
    );
  });

  it("rejects an incomplete next signer verifier", async () => {
    vi.stubEnv("DUST_FRONT_REGISTRY_NEXT_KEY_ID", "key-2");
    const { pocRoutesForMaintenance } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    await expect(pocRoutesForMaintenance()).rejects.toThrow("configuration");
    expect(Resolver).not.toHaveBeenCalled();
  });
});

describe("isolated Dust POC direct provider mode", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("DUST_POC_MODE", "1");
    vi.stubEnv("DUST_FRONT_VERTEX_PROVIDER_IO_ENABLED", "1");
    vi.stubEnv("DUST_POC_DIRECT_PROVIDER_MODE", "1");
    vi.stubEnv("DUST_POC_DIRECT_WORKSPACE_ID", "workspace-a");
    vi.stubEnv("DUST_POC_DIRECT_DAILY_TOKEN_LIMIT", "500000");
    vi.stubEnv("DUST_FRONT_VERTEX_EMBEDDING_SELECTION_ENABLED", "1");
    authorizeDirect.mockResolvedValue({
      attempt: { attemptId: "attempt-1" },
    } as never);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("authorizes the configured workspace without the signed registry", async () => {
    const { authorizePocGeneration } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    await authorizePocGeneration(selection);
    expect(authorizeDirect).toHaveBeenCalledWith({
      identity,
      conversationId: "conversation-a",
      model: "gemini-3.7-flash",
      directWorkspaceId: "workspace-a",
      dailyTokenLimit: 500000,
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(Resolver).not.toHaveBeenCalled();
  });

  it("keeps the server-selected model and provider", async () => {
    const { authorizePocGeneration } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    await expect(
      authorizePocGeneration({ ...selection, modelId: "gemini-2.5-flash" })
    ).rejects.toThrow("unavailable");
    await expect(
      authorizePocGeneration({ ...selection, inferenceRegion: "eu" })
    ).rejects.toThrow("unavailable");
    expect(authorizeDirect).not.toHaveBeenCalled();
  });

  it.each([
    ["DUST_FRONT_VERTEX_PROVIDER_IO_ENABLED", "0"],
    ["DUST_POC_DIRECT_PROVIDER_MODE", "true"],
    ["DUST_POC_DIRECT_WORKSPACE_ID", "workspace a"],
    ["DUST_POC_DIRECT_DAILY_TOKEN_LIMIT", "0"],
    ["DUST_POC_DIRECT_DAILY_TOKEN_LIMIT", "12.5"],
  ])("fails closed for %s=%s", async (key, value) => {
    vi.stubEnv(key, value);
    const { authorizePocGeneration } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    await expect(authorizePocGeneration(selection)).rejects.toThrow();
    expect(authorizeDirect).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });

  it("requires POC mode", async () => {
    vi.stubEnv("DUST_POC_MODE", "0");
    const { dustPocDirectProviderMode } = await import(
      "@app/lib/api/dust_poc_mode"
    );
    expect(() => dustPocDirectProviderMode()).toThrow("unavailable");
  });

  it("selects Vertex for the direct workspace without the signed registry", async () => {
    const { selectPocEmbeddingProvider } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    expect(await selectPocEmbeddingProvider(identity, "workspace-a")).toBe(
      "vertex_ai"
    );
    expect(Resolver).not.toHaveBeenCalled();
  });

  it("leaves an unrelated workspace's embedding provider alone", async () => {
    const { selectPocEmbeddingProvider } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    expect(
      await selectPocEmbeddingProvider(
        { ...identity, workspaceId: "workspace-c" },
        "workspace-c"
      )
    ).toBeNull();
    expect(Resolver).not.toHaveBeenCalled();
  });

  it("lets only the direct workspace omit an OpenAI embedding key", async () => {
    const { isConfiguredPocVertexEmbeddingWorkspace } = await import(
      "@app/lib/api/dust_poc_mode"
    );
    expect(isConfiguredPocVertexEmbeddingWorkspace("workspace-a")).toBe(true);
    expect(isConfiguredPocVertexEmbeddingWorkspace("workspace-c")).toBe(false);
  });

  it.each([
    ["the embedding switch is off", "0", identity],
    ["there is no member identity", "1", null],
    [
      "the identity is for another workspace",
      "1",
      { ...identity, workspaceId: "workspace-c" },
    ],
  ])("refuses the direct workspace when %s", async (_case, enabled, caller) => {
    vi.stubEnv("DUST_FRONT_VERTEX_EMBEDDING_SELECTION_ENABLED", enabled);
    const { selectPocEmbeddingProvider } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    await expect(
      selectPocEmbeddingProvider(caller, "workspace-a")
    ).rejects.toThrow("Dust POC embedding unavailable");
    expect(Resolver).not.toHaveBeenCalled();
  });

  it.each([
    ["DUST_POC_DIRECT_PROVIDER_MODE", "true"],
    ["DUST_POC_DIRECT_WORKSPACE_ID", "workspace a"],
  ])("fails embedding selection closed for %s=%s", async (key, value) => {
    vi.stubEnv(key, value);
    const { selectPocEmbeddingProvider } = await import(
      "@app/lib/api/dust_poc_runtime"
    );
    const { isConfiguredPocVertexEmbeddingWorkspace } = await import(
      "@app/lib/api/dust_poc_mode"
    );
    await expect(
      selectPocEmbeddingProvider(identity, "workspace-a")
    ).rejects.toThrow("configuration unavailable");
    expect(() =>
      isConfiguredPocVertexEmbeddingWorkspace("workspace-a")
    ).toThrow("configuration unavailable");
    expect(Resolver).not.toHaveBeenCalled();
  });
});
