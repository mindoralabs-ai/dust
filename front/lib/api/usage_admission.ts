/** Server-side Dust quota admission. The caller must select the tenant route and
 * front component key from a verified, server-controlled workspace mapping. */
import { z } from "zod";

const ADMISSION_PATH = "/internal/usage/dust/admission";
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4096;
const OPERATION_ID = /^(?!unknown$)[A-Za-z0-9_-]{1,128}$/;

function isPrivateHost(hostname: string): boolean {
  if (
    hostname.endsWith(".internal") ||
    hostname.endsWith(".svc.cluster.local")
  ) {
    return true;
  }
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    return false;
  }
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

export class DustAdmissionDeniedError extends Error {
  constructor() {
    super("Dust model request exceeds the token quota");
    this.name = "DustAdmissionDeniedError";
  }
}

export class DustAdmissionUnavailableError extends Error {
  constructor() {
    super("Dust model request admission is unavailable");
    this.name = "DustAdmissionUnavailableError";
  }
}

type AdmissionOptions = {
  /** Full private CRM URL selected from the verified tenant mapping. */
  routeUrl: string;
  /** Mounted SERVICE_AUTH_KEY_DUST_FRONT_USAGE value for that same tenant. */
  componentKey: string;
  /** Stable ID for one provider attempt; also used as journal attempt_id. */
  operationId: string;
  /** Only a newly committed journal row may authorize provider dispatch. */
  startOutcome: "created" | "duplicate";
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const periodSchema = z.string().datetime({ offset: true });
const tokenSchema = z
  .object({
    used: z.number().int().nonnegative().safe(),
    limit: z.number().int().nonnegative().safe().nullable(),
    allowed: z.boolean(),
  })
  .strict();
const decisionSchema = z
  .object({
    enforcement_enabled: z.literal(true),
    allowed: z.boolean(),
    period_start: periodSchema,
    period_end: periodSchema,
    dimensions: z.object({ tokens: tokenSchema }).strict(),
    denied_dimensions: z.array(z.literal("tokens")).max(1),
    code: z.union([z.literal("quota_exceeded"), z.null()]),
  })
  .strict()
  .superRefine((decision, ctx) => {
    const tokens = decision.dimensions.tokens;
    const coherent =
      Date.parse(decision.period_start) < Date.parse(decision.period_end) &&
      tokens.allowed ===
        (tokens.limit === null || tokens.used < tokens.limit) &&
      tokens.allowed === decision.allowed &&
      (decision.allowed
        ? decision.denied_dimensions.length === 0 && decision.code === null
        : decision.denied_dimensions.length === 1 &&
          decision.code === "quota_exceeded");
    if (!coherent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid quota decision",
      });
    }
  });

function decisionFromResponse(value: unknown): "allowed" | "denied" | null {
  const decision = decisionSchema.safeParse(value);
  return decision.success
    ? decision.data.allowed
      ? "allowed"
      : "denied"
    : null;
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new DustAdmissionUnavailableError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new DustAdmissionUnavailableError();
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Resolve admission once per provider attempt, immediately before provider I/O.
 * This function never retries and returns only when CRM positively allows it. */
export async function requireDustAdmission({
  routeUrl,
  componentKey,
  operationId,
  startOutcome,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: AdmissionOptions): Promise<void> {
  if (
    startOutcome !== "created" ||
    !OPERATION_ID.test(operationId) ||
    !componentKey ||
    componentKey.trim() !== componentKey ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new DustAdmissionUnavailableError();
  }

  let url: URL;
  try {
    url = new URL(routeUrl);
  } catch {
    throw new DustAdmissionUnavailableError();
  }
  if (
    url.protocol !== "https:" ||
    !isPrivateHost(url.hostname) ||
    url.pathname !== ADMISSION_PATH ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new DustAdmissionUnavailableError();
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Auth": componentKey,
      },
      body: JSON.stringify({ operation_id: operationId }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    // Never propagate network errors: they may contain the selected URL or key.
    throw new DustAdmissionUnavailableError();
  }

  if (response.status !== 200) {
    throw new DustAdmissionUnavailableError();
  }

  let body: unknown;
  try {
    body = await readBoundedResponse(response);
  } catch {
    throw new DustAdmissionUnavailableError();
  }
  const decision = decisionFromResponse(body);
  if (decision === "denied") {
    throw new DustAdmissionDeniedError();
  }
  if (decision !== "allowed") {
    throw new DustAdmissionUnavailableError();
  }
}
