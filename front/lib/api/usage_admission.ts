/** Server-side Dust quota admission. The caller must select the tenant route and
 * front component key from a verified, server-controlled workspace mapping. */

const ADMISSION_PATH = "/internal/usage/dust/admission";
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 10_000;
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
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  keys: string[]
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isPeriod(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" &&
      /(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
      !Number.isNaN(Date.parse(value)))
  );
}

function decisionFromResponse(value: unknown): "allowed" | "denied" | null {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "enforcement_enabled",
      "allowed",
      "period_start",
      "period_end",
      "dimensions",
      "denied_dimensions",
      "code",
    ]) ||
    value.enforcement_enabled !== true ||
    typeof value.allowed !== "boolean" ||
    !isPeriod(value.period_start) ||
    !isPeriod(value.period_end) ||
    !isRecord(value.dimensions) ||
    !hasExactlyKeys(value.dimensions, ["tokens"]) ||
    !isRecord(value.dimensions.tokens) ||
    !hasExactlyKeys(value.dimensions.tokens, ["used", "limit", "allowed"])
  ) {
    return null;
  }

  const tokens = value.dimensions.tokens;
  if (
    !Number.isSafeInteger(tokens.used) ||
    (tokens.used as number) < 0 ||
    (tokens.limit !== null &&
      (!Number.isSafeInteger(tokens.limit) || (tokens.limit as number) < 0)) ||
    typeof tokens.allowed !== "boolean" ||
    tokens.allowed !==
      (tokens.limit === null ||
        (tokens.used as number) < (tokens.limit as number)) ||
    tokens.allowed !== value.allowed ||
    !Array.isArray(value.denied_dimensions)
  ) {
    return null;
  }

  if (value.allowed) {
    return value.denied_dimensions.length === 0 && value.code === null
      ? "allowed"
      : null;
  }
  return value.denied_dimensions.length === 1 &&
    value.denied_dimensions[0] === "tokens" &&
    value.code === "quota_exceeded"
    ? "denied"
    : null;
}

/** Resolve admission once per provider attempt, immediately before provider I/O.
 * This function never retries and returns only when CRM positively allows it. */
export async function requireDustAdmission({
  routeUrl,
  componentKey,
  operationId,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: AdmissionOptions): Promise<void> {
  if (
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
    body = await response.json();
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
