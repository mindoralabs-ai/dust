import type { Authenticator } from "@app/lib/auth";
import { createHono } from "@front-api/lib/hono";
import type { WorkspaceAwareCtx } from "@front-api/middlewares/ctx";
import { describe, expect, it, vi } from "vitest";

const { getElevenLabsMock } = vi.hoisted(() => ({
  getElevenLabsMock: vi.fn(),
}));

vi.mock("@app/lib/api/regions/config", () => ({
  config: { getCurrentRegion: () => "asia-southeast1" },
}));

vi.mock("@app/types/api/credentials", () => ({
  dustManagedServiceCredentials: () => ({ ELEVENLABS_API_KEY: "test-key" }),
}));

vi.mock("@app/lib/utils/transcribe_service", () => ({
  getElevenLabs: getElevenLabsMock,
  REGION_TO_ELEVENLABS_ENVIRONMENT: {},
}));

import tokenRoute from "./get-token";

describe("GET /api/w/:wId/services/transcribe/get-token", () => {
  it("rejects Singapore before contacting ElevenLabs", async () => {
    getElevenLabsMock.mockClear();
    const app = createHono<WorkspaceAwareCtx>();
    app.use("*", async (ctx, next) => {
      ctx.set("auth", {
        getNonNullablePlan: () => ({ isByok: false }),
      } as unknown as Authenticator);
      await next();
    });
    app.route("/", tokenRoute);

    const response = await app.request("/");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: {
        type: "internal_server_error",
        message: "ElevenLabs transcription is not configured for Singapore",
      },
    });
    expect(getElevenLabsMock).not.toHaveBeenCalled();
  });
});
