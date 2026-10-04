import config from "@app/lib/api/config";
import { getLlmCredentials } from "@app/lib/api/provider_credentials";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { ProviderCredentialFactory } from "@app/tests/utils/ProviderCredentialFactory";
import { Ok } from "@app/types/shared/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCredentials = vi.fn();

vi.mock("@app/types/oauth/oauth_api", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    OAuthAPI: vi.fn().mockImplementation(function () {
      return {
        getCredentials: mockGetCredentials,
      };
    }),
  };
});

const BASE_VARIABLES = {
  OPENAI_BASE_URL: "",
  OPENAI_USE_EU_ENDPOINT: "false",
};

describe("getLlmCredentials", () => {
  beforeEach(() => {
    mockGetCredentials.mockResolvedValue(
      new Ok({ credential: { content: { api_key: "sk-test" } } })
    );
  });

  it("returns Dust-managed LLM credentials for non-BYOK workspaces", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });

    const result = await getLlmCredentials(authenticator, {
      skipEmbeddingApiKeyRequirement: true,
    });

    expect(result).toEqual({
      ANTHROPIC_API_KEY: "",
      AZURE_OPENAI_API_KEY: "",
      AZURE_OPENAI_ENDPOINT: "",
      MISTRAL_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_USE_EU_ENDPOINT: "false",
      TEXTSYNTH_API_KEY: "",
      GOOGLE_AI_STUDIO_API_KEY: "",
      DEEPSEEK_API_KEY: "",
      FIREWORKS_API_KEY: "",
      XAI_API_KEY: "",
    });
  });

  it("returns mapped credentials for BYOK workspace with multiple providers", async () => {
    const { authenticator } = await createResourceTest({
      role: "admin",
      isByok: true,
    });
    const workspace = authenticator.getNonNullableWorkspace();

    await ProviderCredentialFactory.basic(workspace, "openai");
    await ProviderCredentialFactory.basic(workspace, "anthropic");

    mockGetCredentials.mockImplementation(
      ({ credentialsId }: { credentialsId: string }) => {
        if (credentialsId === "cred-openai") {
          return new Ok({
            credential: { content: { api_key: "sk-openai-test" } },
          });
        }
        if (credentialsId === "cred-anthropic") {
          return new Ok({
            credential: { content: { api_key: "sk-anthropic-test" } },
          });
        }
        throw new Error(`Unexpected credentialsId: ${credentialsId}`);
      }
    );

    const result = await getLlmCredentials(authenticator, {
      skipEmbeddingApiKeyRequirement: true,
    });

    expect(result).toEqual({
      OPENAI_API_KEY: "sk-openai-test",
      OPENAI_EMBEDDING_API_KEY: "sk-openai-test",
      ANTHROPIC_API_KEY: "sk-anthropic-test",
      ...BASE_VARIABLES,
    });
  });

  it("returns empty credentials for BYOK workspace with no providers", async () => {
    const { authenticator } = await createResourceTest({
      role: "admin",
      isByok: true,
    });

    const result = await getLlmCredentials(authenticator, {
      skipEmbeddingApiKeyRequirement: true,
    });

    expect(result).toEqual(BASE_VARIABLES);
  });

  describe("skipEmbeddingApiKeyRequirement", () => {
    it("does not throw for non-BYOK workspaces even without embedding key", async () => {
      const { authenticator } = await createResourceTest({ role: "admin" });

      const result = await getLlmCredentials(authenticator);

      expect(result.OPENAI_EMBEDDING_API_KEY).toBeUndefined();
    });

    it("does not throw for BYOK workspace when OpenAI credentials are configured", async () => {
      const { authenticator } = await createResourceTest({
        role: "admin",
        isByok: true,
      });
      const workspace = authenticator.getNonNullableWorkspace();

      await ProviderCredentialFactory.basic(workspace, "openai");

      const result = await getLlmCredentials(authenticator);

      expect(result.OPENAI_EMBEDDING_API_KEY).toBe("sk-test");
    });

    it("throws for BYOK workspace when OpenAI credentials are not configured", async () => {
      const { authenticator } = await createResourceTest({
        role: "admin",
        isByok: true,
      });

      await expect(getLlmCredentials(authenticator)).rejects.toThrow(
        "[BYOK] This action requires OPENAI_EMBEDDING_API_KEY to be configured."
      );
    });

    it("throws for BYOK workspace when only non-OpenAI credentials are configured", async () => {
      const { authenticator } = await createResourceTest({
        role: "admin",
        isByok: true,
      });
      const workspace = authenticator.getNonNullableWorkspace();

      await ProviderCredentialFactory.basic(workspace, "anthropic");

      await expect(getLlmCredentials(authenticator)).rejects.toThrow(
        "[BYOK] This action requires OPENAI_EMBEDDING_API_KEY to be configured."
      );
    });

    it("does not throw for BYOK workspace when skipping embedding key requirement", async () => {
      const { authenticator } = await createResourceTest({
        role: "admin",
        isByok: true,
      });

      const result = await getLlmCredentials(authenticator, {
        skipEmbeddingApiKeyRequirement: true,
      });

      expect(result).toEqual(BASE_VARIABLES);
    });

    // EnvironmentConfig caches values for the whole file, so each case sets
    // its POC workspace through config rather than the environment.
    const POC_MODES: [
      string,
      (workspaceId: string) => { mockRestore(): void }[],
    ][] = [
      [
        "in signed POC mode",
        (workspaceId) => [
          vi.spyOn(config, "getDustPocMode").mockReturnValue("1"),
          vi
            .spyOn(config, "getDustPocDirectProviderMode")
            .mockReturnValue(undefined),
          vi
            .spyOn(config, "getDustPocWorkspaceIds")
            .mockReturnValue(`${workspaceId},other-workspace`),
        ],
      ],
      [
        "in direct POC provider mode",
        (workspaceId) => [
          vi.spyOn(config, "getDustPocMode").mockReturnValue("1"),
          vi.spyOn(config, "getDustPocDirectProviderMode").mockReturnValue("1"),
          vi
            .spyOn(config, "getDustPocDirectWorkspaceId")
            .mockReturnValue(workspaceId),
          vi.spyOn(config, "getDustPocWorkspaceIds").mockImplementation(() => {
            throw new Error("DUST_POC_WORKSPACE_IDS is required but not set");
          }),
        ],
      ],
    ];

    it.each(
      POC_MODES
    )("requires an OpenAI embedding key from a BYOK POC workspace %s unless the caller skips it", async (_mode, configurePoc) => {
      const { authenticator } = await createResourceTest({
        role: "admin",
        isByok: true,
      });
      const spies = configurePoc(authenticator.getNonNullableWorkspace().sId);
      try {
        await expect(getLlmCredentials(authenticator)).rejects.toThrow(
          "[BYOK] This action requires OPENAI_EMBEDDING_API_KEY to be configured."
        );
        expect(
          await getLlmCredentials(authenticator, {
            skipEmbeddingApiKeyRequirement: true,
          })
        ).toEqual(BASE_VARIABLES);
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    });

    it.each(
      POC_MODES
    )("never requires an OpenAI embedding key from a non-BYOK POC workspace %s", async (_mode, configurePoc) => {
      const { authenticator } = await createResourceTest({ role: "admin" });
      const spies = configurePoc(authenticator.getNonNullableWorkspace().sId);
      try {
        const result = await getLlmCredentials(authenticator);
        expect(result.OPENAI_EMBEDDING_API_KEY).toBeUndefined();
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    });
  });

  it("throws when OAuth fetch fails for a provider", async () => {
    const { authenticator } = await createResourceTest({
      role: "admin",
      isByok: true,
    });
    const workspace = authenticator.getNonNullableWorkspace();

    await ProviderCredentialFactory.basic(workspace, "openai");

    mockGetCredentials.mockResolvedValue({
      isErr: () => true,
      error: { message: "OAuth service unavailable" },
    });

    await expect(
      getLlmCredentials(authenticator, {
        skipEmbeddingApiKeyRequirement: true,
      })
    ).rejects.toThrow("Failed to fetch OAuth credentials for provider openai");
  });
});
