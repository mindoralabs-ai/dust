import config from "@app/lib/api/config";
import type { Authenticator } from "@app/lib/auth";
import { DataSourceResource } from "@app/lib/resources/data_source_resource";
import jwt from "jsonwebtoken";

export type CoreDataSourcePair = { projectId: string; dataSourceId: string };

function pairKey(pair: CoreDataSourcePair): string {
  return `${pair.projectId}:${pair.dataSourceId}`;
}

function signAssertion(
  workspaceSId: string,
  pairs: { project_id: number; data_source_id: string }[],
  secret: string
): string {
  return jwt.sign(
    { workspace_sid: workspaceSId, data_sources: pairs },
    secret,
    {
      algorithm: "HS256",
      audience: "dust-core-vertex-embedding",
      expiresIn: "60s",
    }
  );
}

/** Resolve bounded batches once, then sign an exact one-pair token per request. */
export async function createCoreWorkspaceAssertionsForSingles(
  auth: Authenticator,
  pairs: CoreDataSourcePair[]
): Promise<ReadonlyMap<string, string> | undefined> {
  const secret = config.getCoreWorkspaceAssertionSecret();
  if (!secret) {
    return undefined;
  }
  if (secret.length < 32) {
    throw new Error(
      "Invalid Core workspace assertion configuration or request"
    );
  }
  const unique = [
    ...new Map(pairs.map((pair) => [pairKey(pair), pair])).values(),
  ];
  const workspace = auth.getNonNullableWorkspace();
  const assertions = new Map<string, string>();
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    const resources = await DataSourceResource.fetchByDustAPIDataSourceIds(
      auth,
      batch.map((pair) => pair.dataSourceId)
    );
    const allowed = new Set(
      resources
        .filter((resource) => resource.workspaceId === workspace.id)
        .map(
          (resource) =>
            `${resource.dustAPIProjectId}:${resource.dustAPIDataSourceId}`
        )
    );
    for (const pair of batch) {
      if (!/^[1-9][0-9]*$/.test(pair.projectId)) {
        throw new Error("Invalid Core project id");
      }
      const projectId = Number(pair.projectId);
      if (!Number.isSafeInteger(projectId) || !allowed.has(pairKey(pair))) {
        throw new Error(
          "Core data source is not bound to the authenticated workspace"
        );
      }
      assertions.set(
        pairKey(pair),
        signAssertion(
          workspace.sId,
          [{ project_id: projectId, data_source_id: pair.dataSourceId }],
          secret
        )
      );
    }
  }
  return assertions;
}

/**
 * @cc [label:security;backend] dust-core-assertion-workspace-binding
 * Mint only after resolving every exact Core project/data-source pair through
 * the authenticated workspace's resources. Never sign caller-supplied pairs
 * without this workspace-bound lookup.
 */
export async function createCoreWorkspaceAssertion(
  auth: Authenticator,
  pairs: CoreDataSourcePair[]
): Promise<string | undefined> {
  const secret = config.getCoreWorkspaceAssertionSecret();
  if (!secret) {
    // Existing providers do not require this header. Core rejects Vertex without it.
    return undefined;
  }
  if (secret.length < 32 || pairs.length === 0 || pairs.length > 100) {
    throw new Error(
      "Invalid Core workspace assertion configuration or request"
    );
  }
  const workspace = auth.getNonNullableWorkspace();
  const resources = await DataSourceResource.fetchByDustAPIDataSourceIds(
    auth,
    pairs.map((p) => p.dataSourceId)
  );
  const allowed = new Set(
    resources
      .filter((resource) => resource.workspaceId === workspace.id)
      .map(
        (resource) =>
          `${resource.dustAPIProjectId}:${resource.dustAPIDataSourceId}`
      )
  );
  const requested = pairs.map((pair) => {
    if (!/^[1-9][0-9]*$/.test(pair.projectId)) {
      throw new Error("Invalid Core project id");
    }
    const projectId = Number(pair.projectId);
    if (
      !Number.isSafeInteger(projectId) ||
      projectId <= 0 ||
      !allowed.has(`${projectId}:${pair.dataSourceId}`)
    ) {
      throw new Error(
        "Core data source is not bound to the authenticated workspace"
      );
    }
    return { project_id: projectId, data_source_id: pair.dataSourceId };
  });
  // Multiple authorized views can refer to the same Core data source.
  const uniqueRequested = Array.from(
    new Map(
      requested.map((pair) => [
        `${pair.project_id}:${pair.data_source_id}`,
        pair,
      ])
    ).values()
  );
  return signAssertion(workspace.sId, uniqueRequested, secret);
}
