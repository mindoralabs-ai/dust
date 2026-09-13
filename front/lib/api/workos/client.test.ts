import { beforeEach, describe, expect, it, vi } from "vitest";

const { configMock, workOSConstructor } = vi.hoisted(() => ({
  configMock: {
    getWorkOSApiHostname: vi.fn(() => "workos-api.internal.example.com"),
    getWorkOSApiKey: vi.fn(() => "api-key"),
    getWorkOSClientId: vi.fn(() => "client-id"),
  },
  workOSConstructor: vi.fn(),
}));

vi.mock("@app/lib/api/config", () => ({ default: configMock }));
vi.mock("@workos-inc/node", () => ({ WorkOS: workOSConstructor }));

describe("WorkOS clients", () => {
  beforeEach(() => {
    vi.resetModules();
    workOSConstructor.mockClear();
  });

  it("uses the configured hostname with independent request timeouts", async () => {
    const { getWorkOS, getWorkOSForSessionAuth } = await import("./client");

    getWorkOS();
    getWorkOSForSessionAuth();

    expect(workOSConstructor).toHaveBeenNthCalledWith(1, "api-key", {
      apiHostname: "workos-api.internal.example.com",
      clientId: "client-id",
      timeout: 10_000,
    });
    expect(workOSConstructor).toHaveBeenNthCalledWith(2, "api-key", {
      apiHostname: "workos-api.internal.example.com",
      clientId: "client-id",
      timeout: 5_000,
    });
  });
});
