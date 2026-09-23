import config from "@app/lib/api/config";
import type { AuthorizedDustGenerationAttempt } from "@app/lib/api/dust_generation_gate";
import { authorizeDustGenerationAttempt } from "@app/lib/api/dust_generation_gate";
import { dustPocMode } from "@app/lib/api/dust_poc_mode";
import type {
  ActiveDustIdentity,
  TenantRoute,
} from "@app/lib/api/tenant_route";
import { DustTenantRouteResolver } from "@app/lib/api/tenant_route";
import type { Authenticator } from "@app/lib/auth";

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
  const resolver = new DustTenantRouteResolver({
    signerUrl: required(config.getDustFrontRegistrySignerUrl()),
    exportCredentialFile: required(config.getDustFrontRegistryExportKeyFile()),
    verifiers: [
      {
        keyId: required(config.getDustFrontRegistryKeyId()),
        publicKeyBase64: required(config.getDustFrontRegistryPublicKeyBase64()),
      },
    ],
    minimumRevision,
  });
  await resolver.start();
  return { resolver, workspaces };
}

/**
 * @cc [label:security;backend] dust-poc-generation-selection
 * An isolated POC instance accepts only the server-selected global Gemini
 * model and two configured workspaces; signed membership supplies the tenant.
 * The default-off provider switch must be armed before any model request.
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
 * Only a signed, active POC workspace may select Vertex for a new data source.
 * Non-POC workspaces retain their existing provider, and a disabled POC
 * embedding switch denies selection before Core project creation.
 */
export async function selectPocEmbeddingProvider(
  identity: ActiveDustIdentity | null,
  workspaceId: string
): Promise<"vertex_ai" | null> {
  if (!dustPocMode()) {
    return null;
  }
  if (!configuredPocWorkspaces().has(workspaceId)) {
    return null;
  }
  if (
    !config.getDustFrontVertexEmbeddingSelectionEnabled() ||
    !identity ||
    identity.workspaceId !== workspaceId
  ) {
    throw new Error("Dust POC embedding unavailable");
  }
  const runtime = await getRuntime();
  if (runtime.resolver.resolve(identity).workspaceId !== workspaceId) {
    throw new Error("Dust POC embedding unavailable");
  }
  return "vertex_ai";
}

/** Use this boundary for every authenticated Core data-source creation path. */
export async function selectPocEmbeddingProviderForAuth(
  auth: Authenticator,
  workspaceId: string
): Promise<"vertex_ai" | null> {
  const workspace = auth.getNonNullableWorkspace();
  if (workspace.sId !== workspaceId) {
    throw new Error("Dust workspace mismatch");
  }
  const user = auth.user();
  const identity =
    user?.workOSUserId && workspace.workOSOrganizationId
      ? {
          workspaceId: workspace.sId,
          workosOrganizationId: workspace.workOSOrganizationId,
          workosUserId: user.workOSUserId,
          dustUserId: user.sId,
        }
      : null;
  return selectPocEmbeddingProvider(identity, workspaceId);
}
