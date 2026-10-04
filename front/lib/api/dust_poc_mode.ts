import config from "@app/lib/api/config";

/** Fail closed on a mistyped isolated-instance mode flag. */
export function dustPocMode(): boolean {
  const mode = config.getDustPocMode();
  if (mode === undefined || mode === "0") {
    return false;
  }
  if (mode !== "1") {
    throw new Error("Dust POC mode configuration unavailable");
  }
  return true;
}

/**
 * Direct provider mode serves one POC workspace without the signed tenant
 * registry or CRM admission. It is off unless set to 1, and needs POC mode.
 */
export function dustPocDirectProviderMode(): boolean {
  const mode = config.getDustPocDirectProviderMode();
  if (mode === undefined || mode === "0") {
    return false;
  }
  if (mode !== "1" || !dustPocMode()) {
    throw new Error("Dust POC direct provider mode configuration unavailable");
  }
  return true;
}

/** The one workspace direct provider mode serves. Fails closed if malformed. */
export function configuredDirectPocWorkspaceId(): string {
  const workspaceId = config.getDustPocDirectWorkspaceId();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) {
    throw new Error("Dust POC runtime configuration unavailable");
  }
  return workspaceId;
}
