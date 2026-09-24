import * as converters from "@app/lib/model_constructors/sdk/google_genai/converters/output/utils";
import { usageToTokenUsageEvent } from "@app/lib/model_constructors/sdk/google_genai/converters/output/utils";
import type { EndpointMetadata } from "@app/lib/model_constructors/types/endpoint_metadata";
import type {
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
} from "@google/genai";
import { FinishReason } from "@google/genai";
import { describe, expect, it } from "vitest";

const metadata: EndpointMetadata = {
  lab: "google",
  host: "google-ai-studio",
  model: "gemini-3.5-flash",
  region: "global",
};

it.each([
  FinishReason.MAX_TOKENS,
  FinishReason.MALFORMED_FUNCTION_CALL,
  FinishReason.UNEXPECTED_TOOL_CALL,
  FinishReason.OTHER,
])("preserves exact usage before terminal finish %s", async (finishReason) => {
  const response = {
    responseId: "provider-response-1",
    candidates: [{ finishReason }],
    usageMetadata: {
      promptTokenCount: 3,
      candidatesTokenCount: 2,
      totalTokenCount: 5,
    },
  } as GenerateContentResponse;
  const stream = async function* () {
    yield response;
  };
  const events = [];
  for await (const event of converters.rawOutputToEvents(
    stream(),
    metadata,
    converters
  )) {
    events.push(event);
  }
  expect(events.map((event) => event.type)).toEqual([
    "response_id",
    "token_usage",
    "error",
  ]);
  expect(events[1]).toMatchObject({
    type: "token_usage",
    content: { accountingStatus: "exact", standardInput: 3, totalOutput: 2 },
  });
  expect(events[2]).toMatchObject({
    type: "error",
    content: { providerCompleted: true },
  });
});

describe("usageToTokenUsageEvent", () => {
  it("normalizes separately reported thought tokens into inclusive output", () => {
    const usage: GenerateContentResponseUsageMetadata = {
      promptTokenCount: 25,
      candidatesTokenCount: 36,
      thoughtsTokenCount: 312,
      totalTokenCount: 373,
    };

    expect(usageToTokenUsageEvent(metadata, usage)).toEqual({
      type: "token_usage",
      content: {
        cacheCreated: 0,
        longCacheCreated: 0,
        shortCacheCreated: 0,
        cacheHit: 0,
        standardInput: 25,
        totalOutput: 348,
        reasoning: 312,
        accountingStatus: "exact",
      },
      metadata,
    });
  });

  it("distinguishes complete zero usage from missing metadata", () => {
    const zero = usageToTokenUsageEvent(metadata, {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    });
    const missing = usageToTokenUsageEvent(metadata, undefined);

    expect(zero.content).toMatchObject({
      standardInput: 0,
      totalOutput: 0,
      accountingStatus: "exact",
    });
    expect(missing.content).toMatchObject({
      standardInput: 0,
      totalOutput: 0,
      accountingStatus: "unknown",
    });
  });

  it("marks partial or malformed counts unknown without emitting misleading totals", () => {
    const invalid: GenerateContentResponseUsageMetadata[] = [
      { promptTokenCount: 2 },
      { candidatesTokenCount: 2 },
      { promptTokenCount: -1, candidatesTokenCount: 2 },
      { promptTokenCount: 2.5, candidatesTokenCount: 2 },
      { promptTokenCount: 2, candidatesTokenCount: Number.NaN },
      { promptTokenCount: 2, candidatesTokenCount: Number.MAX_SAFE_INTEGER },
      { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: -1 },
      {
        promptTokenCount: 2,
        candidatesTokenCount: 3,
        cachedContentTokenCount: 4,
      },
      { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 4 },
      { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 6 },
      {
        promptTokenCount: 2,
        candidatesTokenCount: 3,
        toolUsePromptTokenCount: -1,
      },
    ];

    for (const usage of invalid) {
      const content = usageToTokenUsageEvent(metadata, usage).content;
      expect(content.accountingStatus).toBe("unknown");
      expect(Number.isSafeInteger(content.standardInput)).toBe(true);
      expect(Number.isSafeInteger(content.totalOutput)).toBe(true);
      expect(Number.isSafeInteger(content.cacheHit)).toBe(true);
      expect(content.standardInput).toBeGreaterThanOrEqual(0);
      expect(content.totalOutput).toBeGreaterThanOrEqual(0);
      expect(content.cacheHit).toBeGreaterThanOrEqual(0);
    }
  });

  it("retains safe partial counts for legacy consumers but never marks them exact", () => {
    expect(
      usageToTokenUsageEvent(metadata, { promptTokenCount: 8 }).content
    ).toMatchObject({
      standardInput: 8,
      totalOutput: 0,
      accountingStatus: "unknown",
    });
  });

  it("counts valid cache, tool input, and thought subsets without double counting", () => {
    expect(
      usageToTokenUsageEvent(metadata, {
        promptTokenCount: 20,
        toolUsePromptTokenCount: 5,
        cachedContentTokenCount: 10,
        candidatesTokenCount: 7,
        thoughtsTokenCount: 3,
        totalTokenCount: 35,
      }).content
    ).toMatchObject({
      standardInput: 15,
      cacheHit: 10,
      totalOutput: 10,
      reasoning: 3,
      accountingStatus: "exact",
    });
  });
});
