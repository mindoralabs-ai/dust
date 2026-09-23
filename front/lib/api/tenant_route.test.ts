import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DustTenantRouteResolver,
  TenantRouteUnavailable,
} from "./tenant_route";

const signer = generateKeyPairSync("ed25519");
const rawPublic = signer.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32);
const keyId = `ed25519-${createHash("sha256").update(rawPublic).digest("hex").slice(0, 16)}`;
const verifier = { keyId, publicKeyBase64: rawPublic.toString("base64") };
const identity = {
  workspaceId: "workspace-a",
  workosOrganizationId: "org-a",
  workosUserId: "workos-user-a",
  dustUserId: "dust-user-a",
};
const origin = "https://crm-a.internal";
const tenant = {
  tenant_id: "alpha",
  workspace_id: "workspace-a",
  workos_organization_id: "org-a",
  private_route: origin,
  journal_target: "tenant:alpha:dust-usage",
  revision: 7,
  front_credential_ref:
    "/var/run/secrets/dust/tenants/alpha/dust-front-usage-key",
  core_credential_ref:
    "/var/run/secrets/dust/tenants/alpha/dust-core-usage-key",
  active: true,
  admission_url: `${origin}/internal/usage/dust/admission`,
  usage_ingest_url: `${origin}/internal/usage/events`,
};
const member = {
  tenant_id: "alpha",
  employee_id: "employee-a",
  authority_namespace: "control-ui",
  dust_user_id: "dust-user-a",
  workos_user_id: "workos-user-a",
  active: true,
  revision: 7,
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${canonical(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function bundle(payload = {}, domain = "mindora.dust.mapping-bundle.v1\0") {
  const fullPayload = {
    schema_version: 2,
    revision: 7,
    issued_at: 1000,
    expires_at: 1060,
    tenants: [tenant],
    memberships: [member],
    ...payload,
  };
  const message = { key_id: keyId, payload: fullPayload };
  return {
    ...message,
    signature: sign(
      null,
      Buffer.from(domain + canonical(message), "ascii"),
      signer.privateKey
    ).toString("base64"),
  };
}

describe("DustTenantRouteResolver", () => {
  let directory: string;
  let credentialFile: string;
  let now: number;
  let responseBody: unknown;
  let fetchImpl: ReturnType<typeof vi.fn>;
  let resolver: DustTenantRouteResolver;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dust-route-test-"));
    credentialFile = join(directory, "export-key");
    await writeFile(credentialFile, "x".repeat(32));
    now = 1000;
    responseBody = bundle();
    fetchImpl = vi.fn(async () => Response.json(responseBody));
    resolver = new DustTenantRouteResolver({
      signerUrl: "https://signer.internal/internal/dust/registry/bundle",
      exportCredentialFile: credentialFile,
      verifiers: [verifier],
      minimumRevision: 7,
      now: () => now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    resolver.stop();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it("authenticates export and resolves only the active exact identity", async () => {
    await resolver.start();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://signer.internal/internal/dust/registry/bundle",
      expect.objectContaining({
        redirect: "error",
        headers: {
          "X-Internal-Auth": "x".repeat(32),
          Accept: "application/json",
        },
      })
    );
    expect(resolver.resolve(identity)).toEqual(
      expect.objectContaining({
        tenantId: "alpha",
        workspaceId: "workspace-a",
        revision: 7,
        keyId,
        privateRoute: origin,
        frontCredentialRef: tenant.front_credential_ref,
        admissionUrl: tenant.admission_url,
      })
    );
    expect(() =>
      resolver.resolve({ ...identity, workosUserId: "someone-else" })
    ).toThrow(TenantRouteUnavailable);
    expect(() =>
      resolver.resolve({ ...identity, dustUserId: "someone-else" })
    ).toThrow(TenantRouteUnavailable);
    expect(() =>
      resolver.resolve({ ...identity, workosOrganizationId: "other-org" })
    ).toThrow(TenantRouteUnavailable);
  });

  it("lists only configured active POC routes for server maintenance", async () => {
    await resolver.start();
    expect(
      resolver.listActiveRoutesForMaintenance(new Set(["workspace-a"]))
    ).toEqual([expect.objectContaining({ tenantId: "alpha" })]);
    expect(() =>
      resolver.listActiveRoutesForMaintenance(new Set(["workspace-b"]))
    ).toThrow(TenantRouteUnavailable);
    now = 1060;
    expect(() =>
      resolver.listActiveRoutesForMaintenance(new Set(["workspace-a"]))
    ).toThrow(TenantRouteUnavailable);
  });

  it.each([
    [
      "bad signature",
      () => ({ ...bundle(), signature: Buffer.alloc(64).toString("base64") }),
    ],
    ["wrong domain", () => bundle({}, "another.domain\0")],
    ["unknown key", () => ({ ...bundle(), key_id: "ed25519-unknown" })],
    ["v1 schema", () => bundle({ schema_version: 1 })],
    ["expired", () => bundle({ issued_at: 900, expires_at: 960 })],
    ["below minimum revision", () => bundle({ revision: 6 })],
    ["duplicate tenant", () => bundle({ tenants: [tenant, tenant] })],
    [
      "duplicate workspace",
      () =>
        bundle({
          tenants: [
            tenant,
            {
              ...tenant,
              tenant_id: "beta",
              private_route: "https://crm-b.internal",
              journal_target: "tenant:beta:dust-usage",
              front_credential_ref:
                "/var/run/secrets/dust/tenants/beta/dust-front-usage-key",
              core_credential_ref:
                "/var/run/secrets/dust/tenants/beta/dust-core-usage-key",
              admission_url:
                "https://crm-b.internal/internal/usage/dust/admission",
              usage_ingest_url: "https://crm-b.internal/internal/usage/events",
            },
          ],
        }),
    ],
    ["duplicate member", () => bundle({ memberships: [member, member] })],
    [
      "public route",
      () =>
        bundle({
          tenants: [
            {
              ...tenant,
              private_route: "https://example.com",
              admission_url:
                "https://example.com/internal/usage/dust/admission",
              usage_ingest_url: "https://example.com/internal/usage/events",
            },
          ],
        }),
    ],
    [
      "swapped component reference",
      () =>
        bundle({
          tenants: [
            { ...tenant, front_credential_ref: tenant.core_credential_ref },
          ],
        }),
    ],
    [
      "inactive mismatch",
      () => bundle({ tenants: [{ ...tenant, active: false }] }),
    ],
  ])("rejects %s", async (_name, make) => {
    responseBody = make();
    await expect(resolver.start()).rejects.toThrow(TenantRouteUnavailable);
    expect(() => resolver.resolve(identity)).toThrow(TenantRouteUnavailable);
  });

  it("denies inactive memberships even with an inactive tenant entry", async () => {
    responseBody = bundle({
      tenants: [{ ...tenant, active: false }],
      memberships: [{ ...member, active: false }],
    });
    await resolver.start();
    expect(() => resolver.resolve(identity)).toThrow(TenantRouteUnavailable);
  });

  it("delivers a journaled attempt after membership revocation", async () => {
    await resolver.start();
    now = 1045;
    responseBody = bundle({
      revision: 8,
      issued_at: 1045,
      expires_at: 1105,
      tenants: [{ ...tenant, active: false }],
      memberships: [{ ...member, active: false, revision: 8 }],
    });
    await resolver.refresh();
    expect(() => resolver.resolve(identity)).toThrow(TenantRouteUnavailable);
    expect(resolver.resolveForDelivery("alpha", "alpha:7")).toEqual(
      expect.objectContaining({
        tenantId: "alpha",
        revision: 8,
        privateRoute: origin,
        frontCredentialRef: tenant.front_credential_ref,
      })
    );
  });

  it("rejects cross-tenant, future, pre-creation and malformed delivery route IDs", async () => {
    await resolver.start();
    for (const routeId of [
      "beta:7",
      "alpha:8",
      "alpha:6",
      "alpha:07",
      "alpha:7:extra",
    ]) {
      expect(() => resolver.resolveForDelivery("alpha", routeId)).toThrow(
        TenantRouteUnavailable
      );
    }
    expect(() => resolver.resolveForDelivery("beta", "alpha:7")).toThrow(
      TenantRouteUnavailable
    );
  });

  it("blocks historical delivery if an advanced revision changes route identity", async () => {
    await resolver.start();
    now = 1045;
    responseBody = bundle({
      revision: 8,
      issued_at: 1045,
      expires_at: 1105,
      tenants: [
        {
          ...tenant,
          private_route: "https://changed.internal",
          admission_url:
            "https://changed.internal/internal/usage/dust/admission",
          usage_ingest_url: "https://changed.internal/internal/usage/events",
        },
      ],
    });
    await expect(resolver.refresh()).rejects.toThrow(TenantRouteUnavailable);
    expect(() => resolver.resolveForDelivery("alpha", "alpha:7")).toThrow(
      TenantRouteUnavailable
    );
  });

  it("blocks new routes immediately after a signer refresh failure", async () => {
    await resolver.start();
    now = 1045;
    fetchImpl.mockRejectedValueOnce(new Error("signer unavailable"));
    await expect(resolver.refresh()).rejects.toThrow(TenantRouteUnavailable);
    expect(() => resolver.resolve(identity)).toThrow(TenantRouteUnavailable);
    responseBody = bundle({ issued_at: 1045, expires_at: 1105 });
    await resolver.refresh();
    expect(resolver.resolve(identity).tenantId).toBe("alpha");
    now = 1060;
    expect(resolver.resolve(identity).tenantId).toBe("alpha");
  });

  it("rejects a signed revision rollback and blocks new routes", async () => {
    responseBody = bundle({ revision: 8 });
    await resolver.start();
    responseBody = bundle({ revision: 7 });
    await expect(resolver.refresh()).rejects.toThrow(TenantRouteUnavailable);
    expect(() => resolver.resolve(identity)).toThrow(TenantRouteUnavailable);
    responseBody = bundle({ revision: 8 });
    await resolver.refresh();
    expect(resolver.resolve(identity).revision).toBe(8);
  });

  it("accepts renewed timestamps with unchanged bindings at the same revision", async () => {
    await resolver.start();
    now = 1045;
    responseBody = bundle({ issued_at: 1045, expires_at: 1105 });
    await resolver.refresh();
    now = 1060;
    expect(resolver.resolve(identity).revision).toBe(7);
  });

  it("accepts a shared user in two tenants and ignores bundle record order", async () => {
    const secondOrigin = "https://crm-b.internal";
    const secondTenant = {
      ...tenant,
      tenant_id: "beta",
      workspace_id: "workspace-b",
      workos_organization_id: "org-b",
      private_route: secondOrigin,
      journal_target: "tenant:beta:dust-usage",
      front_credential_ref:
        "/var/run/secrets/dust/tenants/beta/dust-front-usage-key",
      core_credential_ref:
        "/var/run/secrets/dust/tenants/beta/dust-core-usage-key",
      admission_url: `${secondOrigin}/internal/usage/dust/admission`,
      usage_ingest_url: `${secondOrigin}/internal/usage/events`,
    };
    const secondMember = {
      ...member,
      tenant_id: "beta",
      employee_id: "employee-b",
    };
    responseBody = bundle({
      tenants: [tenant, secondTenant],
      memberships: [member, secondMember],
    });
    await resolver.start();
    expect(
      resolver.resolve({
        ...identity,
        workspaceId: "workspace-b",
        workosOrganizationId: "org-b",
      }).tenantId
    ).toBe("beta");
    now = 1045;
    responseBody = bundle({
      issued_at: 1045,
      expires_at: 1105,
      tenants: [secondTenant, tenant],
      memberships: [secondMember, member],
    });
    await resolver.refresh();
    expect(resolver.resolve(identity).tenantId).toBe("alpha");
  });

  it.each([
    [
      "route",
      () => ({
        tenants: [
          {
            ...tenant,
            private_route: "https://crm-new.internal",
            admission_url:
              "https://crm-new.internal/internal/usage/dust/admission",
            usage_ingest_url: "https://crm-new.internal/internal/usage/events",
          },
        ],
      }),
    ],
    [
      "membership",
      () => ({ memberships: [{ ...member, workos_user_id: "another-user" }] }),
    ],
  ])("rejects a same-revision %s mutation despite a valid new signature", async (_name, mutate) => {
    await resolver.start();
    now = 1045;
    responseBody = bundle({ issued_at: 1045, expires_at: 1105, ...mutate() });
    await expect(resolver.refresh()).rejects.toThrow(TenantRouteUnavailable);
    expect(() => resolver.resolve(identity)).toThrow(TenantRouteUnavailable);
    responseBody = bundle({ issued_at: 1045, expires_at: 1105 });
    await resolver.refresh();
    expect(resolver.resolve(identity).tenantId).toBe("alpha");
  });

  it("refreshes the signed snapshot before its 60-second expiry", async () => {
    vi.useFakeTimers();
    await resolver.start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    now = 1045;
    responseBody = bundle({ revision: 8, issued_at: 1045, expires_at: 1105 });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(vi.getTimerCount()).toBe(0);
    await resolver.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(resolver.resolve(identity).revision).toBe(8);
    now = 1060;
    expect(resolver.resolve(identity).revision).toBe(8);
  });

  it("rejects signer redirect and public signer configuration", async () => {
    fetchImpl.mockResolvedValueOnce(
      Response.redirect("https://example.com", 302)
    );
    await expect(resolver.start()).rejects.toThrow(TenantRouteUnavailable);
    expect(
      () =>
        new DustTenantRouteResolver({
          signerUrl: "https://example.com/internal/dust/registry/bundle",
          exportCredentialFile: credentialFile,
          verifiers: [verifier],
          minimumRevision: 7,
        })
    ).toThrow(TenantRouteUnavailable);
  });
});
