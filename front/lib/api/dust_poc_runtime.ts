import config from "@app/lib/api/config";
import type { AuthorizedDustGenerationAttempt } from "@app/lib/api/dust_generation_gate";
import {
  authorizeDirectDustGenerationAttempt,
  authorizeDustGenerationAttempt,
} from "@app/lib/api/dust_generation_gate";
import {
  configuredDirectPocWorkspaceId,
  dustPocDirectProviderMode,
  dustPocMode,
} from "@app/lib/api/dust_poc_mode";
import type {
  ActiveDustIdentity,
  TenantRoute,
} from "@app/lib/api/tenant_route";
import { DustTenantRouteResolver } from "@app/lib/api/tenant_route";
import type { Authenticator } from "@app/lib/auth";
import { MembershipResource } from "@app/lib/resources/membership_resource";

const POC_GENERATION_MODEL = "gemini-3.7-flash";

type PocRuntime = {
  resolver: DustTenantRouteResolver;
  workspaces: ReadonlySet<string>;
};

let runtimePromise: Promise<PocRuntime> | null = null;

async function getRuntime(): Promise<PocRuntime> {
  if (!runtimePromise) {
    const starting = initializeRuntime();
    runtimePromise = starting;
    void starting.catch(() => {
      if (runtimePromise === starting) {
        runtimePromise = null;
      }
    });
  }
  return runtimePromise;
}

/** Server-worker access to the same continuously refreshed signed route cache. */
export async function pocRouteResolverForMaintenance(): Promise<DustTenantRouteResolver> {
  if (!dustPocMode()) {
    throw new Error("Dust POC maintenance unavailable");
  }
  return (await getRuntime()).resolver;
}

/** Release the resolver's refresh timer when the POC worker shuts down. */
export async function stopPocRuntime(): Promise<void> {
  const current = runtimePromise;
  runtimePromise = null;
  if (current) {
    (await current).resolver.stop();
  }
}

export async function pocRoutesForMaintenance(): Promise<
  readonly TenantRoute[]
> {
  if (!dustPocMode()) {
    throw new Error("Dust POC maintenance unavailable");
  }
  const runtime = await getRuntime();
  await runtime.resolver.refresh();
  return runtime.resolver.listActiveRoutesForMaintenance(runtime.workspaces);
}

function required(value: string): string {
  if (!value || value.trim() !== value) {
    throw new Error("Dust POC runtime configuration unavailable");
  }
  return value;
}

function configuredPocWorkspaces(): ReadonlySet<string> {
  const workspaceIds = required(config.getDustPocWorkspaceIds()).split(",");
  if (
    workspaceIds.length !== 2 ||
    new Set(workspaceIds).size !== 2 ||
    workspaceIds.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))
  ) {
    throw new Error("Dust POC runtime configuration unavailable");
  }
  return new Set(workspaceIds);
}

async function initializeRuntime(): Promise<PocRuntime> {
  const workspaces = configuredPocWorkspaces();
  const minimumRevision = Number(
    required(config.getDustFrontRegistryMinRevision())
  );
  if (!Number.isSafeInteger(minimumRevision) || minimumRevision < 1) {
    throw new Error("Dust POC runtime configuration unavailable");
  }
  const nextKeyId = config.getDustFrontRegistryNextKeyId();
  const nextPublicKey = config.getDustFrontRegistryNextPublicKeyBase64();
  if (Boolean(nextKeyId) !== Boolean(nextPublicKey)) {
    throw new Error("Dust POC runtime configuration unavailable");
  }
  const verifiers = [
    {
      keyId: required(config.getDustFrontRegistryKeyId()),
      publicKeyBase64: required(config.getDustFrontRegistryPublicKeyBase64()),
    },
  ];
  if (nextKeyId && nextPublicKey) {
    verifiers.push({ keyId: nextKeyId, publicKeyBase64: nextPublicKey });
  }
  const resolver = new DustTenantRouteResolver({
    signerUrl: required(config.getDustFrontRegistrySignerUrl()),
    exportCredentialFile: required(config.getDustFrontRegistryExportKeyFile()),
    verifiers,
    minimumRevision,
  });
  await resolver.start();
  return { resolver, workspaces };
}

function directPocDailyTokenLimit(): number {
  const limit = Number(required(config.getDustPocDirectDailyTokenLimit()));
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Dust POC runtime configuration unavailable");
  }
  return limit;
}

/**
 * @cc [label:security;backend] dust-poc-generation-selection
 * An isolated POC instance accepts only the server-selected global Gemini
 * model. With the signed registry, two configured workspaces and signed
 * membership supply the tenant; in direct provider mode only the one configured
 * workspace may generate, within its daily token limit. The default-off
 * provider switch must be armed before any model request.
 */
export async function authorizePocGeneration(input: {
  identity: ActiveDustIdentity;
  conversationId: string;
  modelId: string;
  providerHost: string;
  providerId: string;
  inferenceRegion: string;
}): Promise<AuthorizedDustGenerationAttempt> {
  if (
    !dustPocMode() ||
    !config.getDustFrontVertexProviderIoEnabled() ||
    input.providerHost !== "agent-platform" ||
    input.providerId !== "google_ai_studio" ||
    input.modelId !== POC_GENERATION_MODEL ||
    input.inferenceRegion !== "global" ||
    !/^[A-Za-z0-9_.:/-]{1,256}$/.test(input.conversationId)
  ) {
    throw new Error("Dust POC generation unavailable");
  }
  if (dustPocDirectProviderMode()) {
    return authorizeDirectDustGenerationAttempt({
      identity: input.identity,
      conversationId: input.conversationId,
      model: input.modelId,
      directWorkspaceId: configuredDirectPocWorkspaceId(),
      dailyTokenLimit: directPocDailyTokenLimit(),
    });
  }
  const runtime = await getRuntime();
  if (!runtime.workspaces.has(input.identity.workspaceId)) {
    throw new Error("Dust POC generation unavailable");
  }
  return authorizeDustGenerationAttempt({
    identity: input.identity,
    conversationId: input.conversationId,
    model: input.modelId,
    pocEnabled: true,
    resolver: runtime.resolver,
  });
}

/**
 * @cc [label:security;backend] dust-poc-new-data-source-embedding
 * Only a signed, active POC workspace, or in direct provider mode the one
 * configured direct workspace with an identity in that workspace, may select
 * Vertex for a new data source. Non-POC and unrelated workspaces retain their
 * existing provider, and a disabled POC embedding switch denies selection
 * before Core project creation.
 */
export async function selectPocEmbeddingProvider(
  identity: ActiveDustIdentity | null,
  workspaceId: string
): Promise<"vertex_ai" | null> {
  if (!dustPocMode()) {
    return null;
  }
  const directMode = dustPocDirectProviderMode();
  const pocWorkspace = directMode
    ? workspaceId === configuredDirectPocWorkspaceId()
    : configuredPocWorkspaces().has(workspaceId);
  if (!pocWorkspace) {
    return null;
  }
  if (
    !config.getDustFrontVertexEmbeddingSelectionEnabled() ||
    !identity ||
    identity.workspaceId !== workspaceId
  ) {
    throw new Error("Dust POC embedding unavailable");
  }
  // Direct mode has no signed registry; the caller's membership is the gate.
  if (directMode) {
    return "vertex_ai";
  }
  const runtime = await getRuntime();
  if (runtime.resolver.resolve(identity).workspaceId !== workspaceId) {
    throw new Error("Dust POC embedding unavailable");
  }
  return "vertex_ai";
}

/** Use this boundary for every authenticated Core data-source creation path. */
/**
 * @cc [owner:jchen0824,label:security;backend] dust-poc-embedding-member-identity
 * Only an authenticator with a workspace role (`auth.isUser()`) supplies an
 * identity, and only when its user has a WorkOS user ID, the workspace has a
 * WorkOS organization, and the user holds an active membership in that
 * workspace (`MembershipResource.getActiveRoleForUserInWorkspace` is not
 * `none`). Internal admins (no user), non-members (role `none`) and non-member
 * super-users, whose `admin` role comes from `Authenticator.fromDustSuperUser`
 * (also after `toJSON`/`fromJSON`), supply none, so they never select Vertex
 * for a POC workspace.
 */
export async function selectPocEmbeddingProviderForAuth(
  auth: Authenticator,
  workspaceId: string
): Promise<"vertex_ai" | null> {
  const workspace = auth.getNonNullableWorkspace();
  if (workspace.sId !== workspaceId) {
    throw new Error("Dust workspace mismatch");
  }
  // Outside POC mode no workspace selects Vertex: skip the membership lookup.
  if (!dustPocMode()) {
    return null;
  }
  const user = auth.user();
  // A super-user's role is not a membership, and `fromJSON` drops the
  // super-user flag, so the membership itself is the gate.
  const identity =
    auth.isUser() &&
    user?.workOSUserId &&
    workspace.workOSOrganizationId &&
    (await MembershipResource.getActiveRoleForUserInWorkspace({
      user,
      workspace,
    })) !== "none"
      ? {
          workspaceId: workspace.sId,
          workosOrganizationId: workspace.workOSOrganizationId,
          workosUserId: user.workOSUserId,
          dustUserId: user.sId,
        }
      : null;
  return selectPocEmbeddingProvider(identity, workspaceId);
}
