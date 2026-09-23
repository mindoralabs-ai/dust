import { describe, expect, it, vi } from "vitest";
import {
  DustAdmissionDeniedError,
  DustAdmissionUnavailableError,
  requireDustAdmission,
} from "./usage_admission";

const ROUTE = "https://crm-private.internal/internal/usage/dust/admission";
const KEY = "front-component-key";
const OPERATION_ID = "attempt_01";

function admission(allowed = true): object {
  return {
    enforcement_enabled: true,
    allowed,
    period_start: "2026-09-01T00:00:00Z",
    period_end: "2026-10-01T00:00:00Z",
    dimensions: {
      tokens: { used: allowed ? 10 : 100, limit: 100, allowed },
    },
    denied_dimensions: allowed ? [] : ["tokens"],
    code: allowed ? null : "quota_exceeded",
  };
}

function fetchReturning(body: unknown, status = 200) {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status })
    );
}

function options(fetchImpl: typeof fetch) {
  return {
    routeUrl: ROUTE,
    componentKey: KEY,
    operationId: OPERATION_ID,
    startOutcome: "created" as const,
    fetchImpl,
  };
}

describe("requireDustAdmission", () => {
  it("posts only the stable attempt ID to the selected private CRM route", async () => {
    const fetchImpl = fetchReturning(admission());
    await requireDustAdmission(options(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(ROUTE);
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth": KEY,
      },
      body: JSON.stringify({ operation_id: OPERATION_ID }),
      cache: "no-store",
      redirect: "error",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps the selected tenant route and component key paired", async () => {
    const fetchImpl = fetchReturning(admission());
    await requireDustAdmission(options(fetchImpl));
    await requireDustAdmission({
      ...options(fetchImpl),
      routeUrl: "https://other-crm.internal/internal/usage/dust/admission",
      componentKey: "other-front-key",
      operationId: "attempt_02",
    });
    expect(fetchImpl.mock.calls[0][0]).toHaveProperty(
      "host",
      "crm-private.internal"
    );
    expect(fetchImpl.mock.calls[0][1]?.headers).toHaveProperty(
      "X-Internal-Auth",
      KEY
    );
    expect(fetchImpl.mock.calls[1][0]).toHaveProperty(
      "host",
      "other-crm.internal"
    );
    expect(fetchImpl.mock.calls[1][1]?.headers).toHaveProperty(
      "X-Internal-Auth",
      "other-front-key"
    );
  });

  it("rejects an explicit token quota denial", async () => {
    await expect(
      requireDustAdmission(options(fetchReturning(admission(false))))
    ).rejects.toBeInstanceOf(DustAdmissionDeniedError);
  });

  it.each([
    {
      name: "disabled enforcement",
      body: { ...admission(), enforcement_enabled: false },
    },
    {
      name: "missing token dimension",
      body: { ...admission(), dimensions: {} },
    },
    {
      name: "contradictory token decision",
      body: {
        ...admission(),
        dimensions: { tokens: { used: 10, limit: 100, allowed: false } },
      },
    },
    {
      name: "extra response field",
      body: { ...admission(), tenant_id: "forged" },
    },
    {
      name: "invalid usage value",
      body: {
        ...admission(),
        dimensions: { tokens: { used: -1, limit: 100, allowed: true } },
      },
    },
    {
      name: "quota arithmetic contradicts allowance",
      body: {
        ...admission(),
        dimensions: { tokens: { used: 100, limit: 100, allowed: true } },
      },
    },
    {
      name: "malformed denial",
      body: { ...admission(false), denied_dimensions: [] },
    },
    { name: "missing period", body: { ...admission(), period_start: null } },
    {
      name: "inverted period",
      body: { ...admission(), period_end: "2026-08-01T00:00:00Z" },
    },
    {
      name: "non-RFC3339 period",
      body: { ...admission(), period_start: "2026-09-01 00:00:00Z" },
    },
  ])("fails closed for $name", async ({ body }) => {
    await expect(
      requireDustAdmission(options(fetchReturning(body)))
    ).rejects.toBeInstanceOf(DustAdmissionUnavailableError);
  });

  it("fails closed on 503, malformed JSON, and network errors", async () => {
    const unavailable = fetchReturning(
      { error: { code: "quota_unavailable" } },
      503
    );
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not json"));
    const network = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`request to ${ROUTE} with ${KEY} failed`));
    for (const fetchImpl of [unavailable, malformed, network]) {
      await expect(requireDustAdmission(options(fetchImpl))).rejects.toEqual(
        new DustAdmissionUnavailableError()
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects an oversized streamed response before parsing", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(4097), { status: 200 }));
    await expect(
      requireDustAdmission(options(fetchImpl))
    ).rejects.toBeInstanceOf(DustAdmissionUnavailableError);
  });

  it("rejects a duplicate journal start before asking CRM for admission", async () => {
    const fetchImpl = fetchReturning(admission());
    await expect(
      requireDustAdmission({ ...options(fetchImpl), startOutcome: "duplicate" })
    ).rejects.toBeInstanceOf(DustAdmissionUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds the request and fails closed on an aborted fetch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect((init?.signal as AbortSignal).aborted).toBe(false);
        throw new DOMException("timed out", "AbortError");
      });
    await expect(
      requireDustAdmission({ ...options(fetchImpl), timeoutMs: 5 })
    ).rejects.toBeInstanceOf(DustAdmissionUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    "unknown",
    "with spaces",
    "",
    "a".repeat(129),
  ])("rejects invalid operation ID %s before sending", async (operationId) => {
    const fetchImpl = fetchReturning(admission());
    await expect(
      requireDustAdmission({ ...options(fetchImpl), operationId })
    ).rejects.toBeInstanceOf(DustAdmissionUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects the generic route and URL credentials before sending", async () => {
    const fetchImpl = fetchReturning(admission());
    for (const routeUrl of [
      "https://crm-private.internal/internal/usage/admission",
      "https://user:password@crm-private.internal/internal/usage/dust/admission",
      "http://crm-private.internal/internal/usage/dust/admission",
      "https://public.example.com/internal/usage/dust/admission",
      `${ROUTE}?tenant=other`,
    ]) {
      await expect(
        requireDustAdmission({ ...options(fetchImpl), routeUrl })
      ).rejects.toBeInstanceOf(DustAdmissionUnavailableError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
