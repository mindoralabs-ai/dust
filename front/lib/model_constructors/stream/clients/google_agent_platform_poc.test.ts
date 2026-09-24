import { consumeDustProviderPermit } from "@app/lib/api/dust_generation_gate";
import { GoogleGeminiThreeDotSevenFlashGlobalAgentPlatformStream } from "@app/lib/model_constructors/stream/endpoints/google_gemini_3_7_flash_global_agent_platform";
import { GoogleGenAI } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/dust_generation_gate", () => ({
  consumeDustProviderPermit: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(
    class {
      models = { generateContentStream: vi.fn() };
    }
  ),
}));

const Google = vi.mocked(GoogleGenAI);
const consumePermit = vi.mocked(consumeDustProviderPermit);

describe("Dust POC Vertex transport permit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DUST_POC_MODE", "1");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects direct SDK calls and consumes an admitted permit once", async () => {
    const endpoint =
      new GoogleGeminiThreeDotSevenFlashGlobalAgentPlatformStream({
        AGENT_PLATFORM_PROJECT_ID: "poc-project",
      } as never);
    const client = Google.mock.results[0].value as GoogleGenAI;
    const call = vi.mocked(client.models.generateContentStream);
    call.mockResolvedValue((async function* () {})() as never);
    const input = { model: "gemini-3.7-flash", contents: "hello" };

    await expect(async () => {
      for await (const _ of endpoint.streamRaw(input)) {
        // Consume the generator so the pre-I/O guard executes.
      }
    }).rejects.toThrow("unavailable");
    expect(call).not.toHaveBeenCalled();

    const permit = {};
    consumePermit.mockImplementation(
      (candidate, id) => candidate === permit && id === "attempt-1"
    );
    expect(() => endpoint.armPocAttempt("attempt-1", {})).toThrow(
      "unavailable"
    );
    endpoint.armPocAttempt("attempt-1", permit);
    for await (const _ of endpoint.streamRaw(input)) {
      // The admitted request may reach the SDK exactly once.
    }
    expect(call).toHaveBeenCalledTimes(1);
    await expect(async () => {
      for await (const _ of endpoint.streamRaw(input)) {
        // A consumed permit cannot be reused for a second request.
      }
    }).rejects.toThrow("unavailable");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects a second permit before the first is consumed", () => {
    const endpoint =
      new GoogleGeminiThreeDotSevenFlashGlobalAgentPlatformStream({
        AGENT_PLATFORM_PROJECT_ID: "poc-project",
      } as never);
    const permit = {};
    consumePermit.mockImplementation((candidate) => candidate === permit);
    endpoint.armPocAttempt("attempt-1", permit);
    expect(() => endpoint.armPocAttempt("attempt-2", permit)).toThrow(
      "unavailable"
    );
  });
});
