import { EMBEDDING_CONFIGS } from "@app/types/core/core_api";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMBEDDING_PROVIDER_ID,
  EMBEDDING_PROVIDER_IDS,
  EmbeddingProviderSchema,
} from "./embedding";

describe("embedding provider configuration", () => {
  it("registers Vertex AI without changing the existing default", () => {
    expect(DEFAULT_EMBEDDING_PROVIDER_ID).toBe("openai");
    expect(EMBEDDING_PROVIDER_IDS).toEqual(["openai", "mistral", "vertex_ai"]);

    for (const providerId of EMBEDDING_PROVIDER_IDS) {
      expect(EmbeddingProviderSchema.parse(providerId)).toBe(providerId);
    }
    expect(EmbeddingProviderSchema.safeParse("google_ai_studio").success).toBe(
      false
    );
  });

  it("maps Vertex AI to the 1536-dimensional Gemini Embedding 2 variant", () => {
    expect(EMBEDDING_CONFIGS.vertex_ai).toEqual({
      provider_id: "vertex_ai",
      model_id: "gemini-embedding-2-1536",
      splitter_id: "base_v0",
      max_chunk_size: 512,
    });
    expect(EMBEDDING_CONFIGS.openai.model_id).toBe(
      "text-embedding-3-large-1536"
    );
    expect(EMBEDDING_CONFIGS.mistral.model_id).toBe("mistral-embed");
  });
});
