import type { AuthorizedDustGenerationAttempt } from "@app/lib/api/dust_generation_gate";
import { authorizeDustGenerationAttempt } from "@app/lib/api/dust_generation_gate";
import { dustPocMode } from "@app/lib/api/dust_poc_mode";
import type { ActiveDustIdentity } from "@app/lib/api/tenant_route";
import { DustTenantRouteResolver } from "@app/lib/api/tenant_route";

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

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() !== value) {
    throw new Error("Dust POC runtime configuration unavailable");
  }
  return value;
}

async function initializeRuntime(): Promise<PocRuntime> {
  const workspaceIds = required("DUST_POC_WORKSPACE_IDS").split(",");
  if (
    workspaceIds.length !== 2 ||
    new Set(workspaceIds).size !== 2 ||
    workspaceIds.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))
  ) {
    throw new Error("Dust POC runtime configuration unavailable");
  }
  const minimumRevision = Number(required("DUST_FRONT_REGISTRY_MIN_REVISION"));
  if (!Number.isSafeInteger(minimumRevision) || minimumRevision < 1) {
    throw new Error("Dust POC runtime configuration unavailable");
  }
  const resolver = new DustTenantRouteResolver({
    signerUrl: required("DUST_FRONT_REGISTRY_SIGNER_URL"),
    exportCredentialFile: required("DUST_FRONT_REGISTRY_EXPORT_KEY_FILE"),
    verifiers: [
      {
        keyId: required("DUST_FRONT_REGISTRY_KEY_ID"),
        publicKeyBase64: required("DUST_FRONT_REGISTRY_PUBLIC_KEY_BASE64"),
      },
    ],
    minimumRevision,
  });
  await resolver.start();
  return { resolver, workspaces: new Set(workspaceIds) };
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
    process.env.DUST_FRONT_VERTEX_PROVIDER_IO_ENABLED !== "1" ||
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

/** Choose Vertex only for signed, active POC workspaces creating new data sources. */
export async function selectPocEmbeddingProvider(
  identity: ActiveDustIdentity | null,
  workspaceId: string
): Promise<"vertex_ai" | null> {
  if (!dustPocMode()) {
    return null;
  }
  const runtime = await getRuntime();
  if (!runtime.workspaces.has(workspaceId)) {
    return null;
  }
  if (
    process.env.DUST_FRONT_VERTEX_EMBEDDING_SELECTION_ENABLED !== "1" ||
    !identity ||
    identity.workspaceId !== workspaceId
  ) {
    throw new Error("Dust POC embedding unavailable");
  }
  if (runtime.resolver.resolve(identity).workspaceId !== workspaceId) {
    throw new Error("Dust POC embedding unavailable");
  }
  return "vertex_ai";
}
