// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockTrace } = vi.hoisted(() => ({ mockTrace: vi.fn() }));

vi.mock("@app/logger/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@app/logger/tracer", () => ({
  default: { trace: mockTrace },
}));

import { E2BSandboxProvider } from "./e2b";

const API_URL = "http://e2b-api.test:50001";
const SANDBOX_URL = "http://192.0.2.10:3002";
const SANDBOX_ID = "isbxrouting1234567890";

// A self-hosted E2B reached through fixed private addresses (E2B_API_URL and
// E2B_SANDBOX_URL) gives the client proxy no sandbox ID in the host name. The proxy
// then routes each request by its E2b-Sandbox-Id and E2b-Sandbox-Port headers, and a
// request without them never reaches the sandbox. e2b 2.14.0 and earlier sent them on
// RPC calls only, not on file reads and writes.
describe("E2BSandboxProvider through a fixed sandbox address", () => {
  const requests: Request[] = [];

  beforeEach(() => {
    requests.length = 0;
    mockTrace.mockImplementation(
      async (
        _name: string,
        _opts: unknown,
        fn: (span: { setTag: (key: string, value: string) => void }) => unknown
      ) => fn({ setTag: vi.fn() })
    );
    vi.stubEnv("E2B_API_URL", API_URL);
    vi.stubEnv("E2B_SANDBOX_URL", SANDBOX_URL);
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url === `${API_URL}/sandboxes/${SANDBOX_ID}/connect`) {
          return Response.json(
            {
              sandboxID: SANDBOX_ID,
              templateID: "dust-base",
              clientID: "client",
              envdVersion: "0.4.0",
            },
            { status: 201 }
          );
        }
        if (new URL(request.url).pathname === "/files") {
          return request.method === "POST"
            ? Response.json([
                { name: "leads.csv", path: "/tmp/leads.csv", type: "file" },
              ])
            : new Response("stage,source\n");
        }
        return new Response("unexpected request", { status: 500 });
      }
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("routes file writes and reads to the sandbox by header", async () => {
    const provider = new E2BSandboxProvider({
      apiKey: "e2b_test",
      domain: undefined,
    });
    const data = new TextEncoder().encode("stage,source\n").buffer;

    const written = await provider.writeFile(
      SANDBOX_ID,
      "/tmp/leads.csv",
      data,
      {
        workspaceId: "w",
      }
    );
    expect(written.isOk()).toBe(true);
    const read = await provider.readFile(SANDBOX_ID, "/tmp/leads.csv", {
      workspaceId: "w",
    });
    expect(read.toString()).toBe("stage,source\n");

    const fileRequests = requests.filter((r) =>
      r.url.startsWith(`${SANDBOX_URL}/files`)
    );
    expect(fileRequests.map((r) => r.method)).toEqual(["POST", "GET"]);
    for (const request of fileRequests) {
      expect(request.headers.get("E2b-Sandbox-Id")).toBe(SANDBOX_ID);
      expect(request.headers.get("E2b-Sandbox-Port")).toBe("49983");
    }
  });
});
