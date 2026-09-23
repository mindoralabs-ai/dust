import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const DOMAIN = Buffer.from("mindora.dust.mapping-bundle.v1\0", "ascii");
const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_BUNDLE_BYTES = 1024 * 1024;
const REFRESH_MARGIN_SECONDS = 15;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysAre(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

// Python's json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=True)
// for the bounded bundle schema. All payload numbers are safe integers.
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (record(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonical(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TenantRouteUnavailable();
  }
  return encoded;
}

function exactBase64(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes && decoded.toString("base64") === value
    ? decoded
    : null;
}

function privateOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== value
    ) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    const octets = host.split(".").map(Number);
    const privateIp =
      octets.length === 4 &&
      octets.every(
        (n, i) => /^\d{1,3}$/.test(host.split(".")[i]) && n >= 0 && n <= 255
      ) &&
      (octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168));
    return (
      privateIp ||
      host.endsWith(".internal") ||
      host.endsWith(".svc.cluster.local")
    );
  } catch {
    return false;
  }
}

const boundedString = z.string().min(1).max(256);
const revisionSchema = z.number().int().nonnegative().safe();
const tenantSchema = z
  .object({
    tenant_id: z.string().regex(TENANT_ID),
    workspace_id: boundedString,
    workos_organization_id: boundedString,
    private_route: z.string().refine(privateOrigin),
    journal_target: z.string(),
    revision: revisionSchema,
    front_credential_ref: z.string(),
    core_credential_ref: z.string(),
    active: z.boolean(),
    admission_url: z.string(),
    usage_ingest_url: z.string(),
  })
  .strict();
const membershipSchema = z
  .object({
    tenant_id: z.string().regex(TENANT_ID),
    employee_id: boundedString,
    authority_namespace: z.literal("control-ui"),
    dust_user_id: boundedString,
    workos_user_id: boundedString,
    active: z.boolean(),
    revision: revisionSchema,
  })
  .strict();
const payloadSchema = z
  .object({
    schema_version: z.literal(2),
    revision: revisionSchema,
    issued_at: revisionSchema,
    expires_at: revisionSchema,
    tenants: z.array(tenantSchema).min(1).max(1000),
    memberships: z.array(membershipSchema).min(1).max(1000),
  })
  .strict();
type Payload = z.infer<typeof payloadSchema>;
type TenantEntry = z.infer<typeof tenantSchema>;

export interface PinnedVerifier {
  keyId: string;
  publicKeyBase64: string;
}

export interface TenantRouteConfig {
  signerUrl: string;
  exportCredentialFile: string;
  verifiers: PinnedVerifier[];
  minimumRevision: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ActiveDustIdentity {
  workspaceId: string;
  workosOrganizationId: string;
  workosUserId: string;
  dustUserId: string;
}

export interface TenantRoute {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly keyId: string;
  readonly privateRoute: string;
  readonly admissionUrl: string;
  readonly usageIngestUrl: string;
  readonly journalTarget: string;
  readonly frontCredentialRef: string;
  readonly coreCredentialRef: string;
}

export class TenantRouteUnavailable extends Error {
  constructor() {
    super("Dust tenant route unavailable");
  }
}

function parsePayload(
  value: unknown,
  now: number,
  minimumRevision: number
): Payload {
  const parsed = payloadSchema.safeParse(value);
  if (!parsed.success) {
    throw new TenantRouteUnavailable();
  }
  const payload = parsed.data;
  if (
    payload.revision < minimumRevision ||
    payload.expires_at !== payload.issued_at + 60 ||
    payload.issued_at > now ||
    now >= payload.expires_at
  ) {
    throw new TenantRouteUnavailable();
  }
  const tenantIds = new Set<string>();
  const workspaceIds = new Set<string>();
  const organizations = new Set<string>();
  const routes = new Set<string>();
  for (const entry of payload.tenants) {
    if (
      entry.revision > payload.revision ||
      entry.journal_target !== `tenant:${entry.tenant_id}:dust-usage` ||
      entry.front_credential_ref !==
        `/var/run/secrets/dust/tenants/${entry.tenant_id}/dust-front-usage-key` ||
      entry.core_credential_ref !==
        `/var/run/secrets/dust/tenants/${entry.tenant_id}/dust-core-usage-key` ||
      entry.front_credential_ref === entry.core_credential_ref ||
      entry.admission_url !==
        `${entry.private_route}/internal/usage/dust/admission` ||
      entry.usage_ingest_url !==
        `${entry.private_route}/internal/usage/events` ||
      tenantIds.has(entry.tenant_id) ||
      workspaceIds.has(entry.workspace_id) ||
      organizations.has(entry.workos_organization_id) ||
      routes.has(entry.private_route)
    ) {
      throw new TenantRouteUnavailable();
    }
    tenantIds.add(entry.tenant_id);
    workspaceIds.add(entry.workspace_id);
    organizations.add(entry.workos_organization_id);
    routes.add(entry.private_route);
  }
  const memberIds = new Set<string>();
  const dustUsers = new Set<string>();
  const workosUsers = new Set<string>();
  const activeTenants = new Set<string>();
  const representedTenants = new Set<string>();
  for (const member of payload.memberships) {
    if (
      !tenantIds.has(member.tenant_id) ||
      member.revision > payload.revision ||
      memberIds.has(`${member.tenant_id}\0${member.employee_id}`) ||
      dustUsers.has(`${member.tenant_id}\0${member.dust_user_id}`) ||
      workosUsers.has(`${member.tenant_id}\0${member.workos_user_id}`)
    ) {
      throw new TenantRouteUnavailable();
    }
    memberIds.add(`${member.tenant_id}\0${member.employee_id}`);
    dustUsers.add(`${member.tenant_id}\0${member.dust_user_id}`);
    workosUsers.add(`${member.tenant_id}\0${member.workos_user_id}`);
    representedTenants.add(member.tenant_id);
    if (member.active) {
      activeTenants.add(member.tenant_id);
    }
  }
  if (
    payload.tenants.some(
      (entry) =>
        !representedTenants.has(entry.tenant_id) ||
        entry.active !== activeTenants.has(entry.tenant_id)
    )
  ) {
    throw new TenantRouteUnavailable();
  }
  return payload;
}

function buildVerifier(verifier: PinnedVerifier) {
  const raw = exactBase64(verifier.publicKeyBase64, 32);
  if (
    !raw ||
    verifier.keyId !==
      `ed25519-${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`
  ) {
    throw new TenantRouteUnavailable();
  }
  // RFC 8410 Ed25519 SubjectPublicKeyInfo prefix.
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki",
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  if (
    !response.ok ||
    response.redirected ||
    response.headers.get("content-type")?.split(";")[0].trim() !==
      "application/json"
  ) {
    throw new TenantRouteUnavailable();
  }
  const body = response.body;
  if (!body) {
    throw new TenantRouteUnavailable();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_BUNDLE_BYTES) {
        throw new TenantRouteUnavailable();
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TenantRouteUnavailable();
  }
}

/** A process-local, fail-closed snapshot. This module must only be imported server-side. */
export class DustTenantRouteResolver {
  private readonly verifiers: Map<string, ReturnType<typeof buildVerifier>>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private snapshot: {
    payload: Payload;
    keyId: string;
    bindingFingerprint: string;
    tenantIdentities: Map<string, string>;
  } | null = null;
  private refreshHealthy = false;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly config: TenantRouteConfig) {
    let signerUrl: URL;
    try {
      signerUrl = new URL(config.signerUrl);
    } catch {
      throw new TenantRouteUnavailable();
    }
    if (
      !privateOrigin(signerUrl.origin) ||
      config.signerUrl !==
        `${signerUrl.origin}/internal/dust/registry/bundle` ||
      !config.exportCredentialFile.startsWith("/") ||
      !integer(config.minimumRevision) ||
      config.verifiers.length < 1 ||
      config.verifiers.length > 2
    ) {
      throw new TenantRouteUnavailable();
    }
    this.verifiers = new Map(
      config.verifiers.map((v) => [v.keyId, buildVerifier(v)])
    );
    if (this.verifiers.size !== config.verifiers.length) {
      throw new TenantRouteUnavailable();
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
  }

  stop(): void {
    this.stopped = true;
    this.snapshot = null;
    this.refreshHealthy = false;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = null;
  }

  async refresh(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.fetchAndVerify().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private schedule(seconds: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      void this.refresh().catch(() => undefined);
    }, Math.max(1, seconds) * 1000);
    this.timer.unref?.();
  }

  private async fetchAndVerify(): Promise<void> {
    try {
      const credential = (
        await readFile(this.config.exportCredentialFile, "utf8")
      ).trim();
      if (credential.length < 32 || /[\r\n]/.test(credential)) {
        throw new TenantRouteUnavailable();
      }
      const response = await this.fetchImpl(this.config.signerUrl, {
        method: "GET",
        headers: { "X-Internal-Auth": credential, Accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(2000),
      });
      const bundle = await boundedJson(response);
      if (
        !record(bundle) ||
        !keysAre(bundle, ["key_id", "payload", "signature"]) ||
        typeof bundle.key_id !== "string"
      ) {
        throw new TenantRouteUnavailable();
      }
      const verifier = this.verifiers.get(bundle.key_id);
      const signature = exactBase64(bundle.signature, 64);
      if (
        !verifier ||
        !signature ||
        !verify(
          null,
          Buffer.concat([
            DOMAIN,
            Buffer.from(
              canonical({
                key_id: bundle.key_id,
                payload: bundle.payload,
              }),
              "ascii"
            ),
          ]),
          verifier,
          signature
        )
      ) {
        throw new TenantRouteUnavailable();
      }
      const payload = parsePayload(
        bundle.payload,
        this.now(),
        Math.max(
          this.config.minimumRevision,
          this.snapshot?.payload.revision ?? 0
        )
      );
      if (this.stopped) {
        throw new TenantRouteUnavailable();
      }
      // Export timestamps and signing key may rotate without a registry mutation.
      // The tenant/member bindings themselves must never change at one revision.
      const bindingFingerprint = createHash("sha256")
        .update(
          canonical({
            tenants: [...payload.tenants].sort((a, b) =>
              a.tenant_id.localeCompare(b.tenant_id)
            ),
            memberships: [...payload.memberships].sort(
              (a, b) =>
                a.tenant_id.localeCompare(b.tenant_id) ||
                a.employee_id.localeCompare(b.employee_id)
            ),
          })
        )
        .digest("hex");
      const tenantIdentities = new Map(
        payload.tenants.map((entry) => {
          const { active: _active, ...immutableFields } = entry;
          return [entry.tenant_id, canonical(immutableFields)];
        })
      );
      if (
        this.snapshot?.payload.revision === payload.revision &&
        this.snapshot.bindingFingerprint !== bindingFingerprint
      ) {
        throw new TenantRouteUnavailable();
      }
      for (const [tenantId, identity] of this.snapshot?.tenantIdentities ??
        []) {
        if (tenantIdentities.get(tenantId) !== identity) {
          throw new TenantRouteUnavailable();
        }
      }
      this.snapshot = {
        payload,
        keyId: bundle.key_id,
        bindingFingerprint,
        tenantIdentities,
      };
      this.refreshHealthy = true;
      this.schedule(
        Math.max(1, payload.expires_at - this.now() - REFRESH_MARGIN_SECONDS)
      );
    } catch {
      this.refreshHealthy = false;
      if (this.snapshot) {
        this.schedule(5);
      }
      throw new TenantRouteUnavailable();
    }
  }

  resolve(identity: ActiveDustIdentity): TenantRoute {
    const current = this.snapshot;
    if (
      !current ||
      !this.refreshHealthy ||
      this.now() >= current.payload.expires_at ||
      current.payload.revision < this.config.minimumRevision ||
      !Object.values(identity).every(nonempty)
    ) {
      throw new TenantRouteUnavailable();
    }
    const tenant = current.payload.tenants.find(
      (entry) =>
        entry.active &&
        entry.workspace_id === identity.workspaceId &&
        entry.workos_organization_id === identity.workosOrganizationId
    );
    if (
      !tenant ||
      !current.payload.memberships.some(
        (member) =>
          member.active &&
          member.tenant_id === tenant.tenant_id &&
          member.workos_user_id === identity.workosUserId &&
          member.dust_user_id === identity.dustUserId
      )
    ) {
      throw new TenantRouteUnavailable();
    }
    return this.route(current, tenant);
  }

  /** Delivery of a committed attempt does not require a still-active member. */
  resolveForDelivery(tenantId: string, routeId: string): TenantRoute {
    const current = this.snapshot;
    if (
      !current ||
      !this.refreshHealthy ||
      this.now() >= current.payload.expires_at ||
      current.payload.revision < this.config.minimumRevision ||
      !TENANT_ID.test(tenantId)
    ) {
      throw new TenantRouteUnavailable();
    }
    const match = /^([a-z0-9][a-z0-9-]{0,62}):([1-9][0-9]*)$/.exec(routeId);
    if (!match || match[1] !== tenantId) {
      throw new TenantRouteUnavailable();
    }
    const journaledRevision = Number(match[2]);
    const tenant = current.payload.tenants.find(
      (entry) => entry.tenant_id === tenantId
    );
    if (
      !Number.isSafeInteger(journaledRevision) ||
      !tenant ||
      journaledRevision < tenant.revision ||
      journaledRevision > current.payload.revision
    ) {
      throw new TenantRouteUnavailable();
    }
    return this.route(current, tenant);
  }

  /** Server-only maintenance routes, restricted to the configured POC workspaces. */
  listActiveRoutesForMaintenance(
    workspaceIds: ReadonlySet<string>
  ): readonly TenantRoute[] {
    const current = this.snapshot;
    if (
      !current ||
      !this.refreshHealthy ||
      this.now() >= current.payload.expires_at ||
      current.payload.revision < this.config.minimumRevision ||
      workspaceIds.size === 0
    ) {
      throw new TenantRouteUnavailable();
    }
    const activeByWorkspace = new Map(
      current.payload.tenants
        .filter((entry) => entry.active)
        .map((entry) => [entry.workspace_id, entry])
    );
    return Array.from(workspaceIds, (workspaceId) => {
      const tenant = activeByWorkspace.get(workspaceId);
      if (!tenant) {
        throw new TenantRouteUnavailable();
      }
      return this.route(current, tenant);
    });
  }

  private route(
    current: NonNullable<DustTenantRouteResolver["snapshot"]>,
    tenant: TenantEntry
  ): TenantRoute {
    return Object.freeze({
      tenantId: tenant.tenant_id,
      workspaceId: tenant.workspace_id,
      revision: current.payload.revision,
      keyId: current.keyId,
      privateRoute: tenant.private_route,
      admissionUrl: tenant.admission_url,
      usageIngestUrl: tenant.usage_ingest_url,
      journalTarget: tenant.journal_target,
      frontCredentialRef: tenant.front_credential_ref,
      coreCredentialRef: tenant.core_credential_ref,
    });
  }
}
