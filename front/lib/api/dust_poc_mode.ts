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
