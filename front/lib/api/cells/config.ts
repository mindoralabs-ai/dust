import type { CellInfo, CellType } from "@app/types/cell";
import { isCellType, SUPPORTED_CELLS } from "@app/types/cell";
import { isDevelopment } from "@app/types/shared/env";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { EnvironmentConfig } from "@app/types/shared/utils/config";

// Ensure we have a CellInfo entry for EVERY CellType by iterating SUPPORTED_CELLS.
const CELLS: Record<CellType, CellInfo> = Object.fromEntries(
  SUPPORTED_CELLS.map((cell) => {
    switch (cell) {
      // US Global
      case "cell-00000":
        return [
          cell,
          {
            name: cell,
            region: "us-central1",
            // Local poke/dev talks to the single local front-api, even when
            // production cell public URLs are configured in the environment.
            url: isDevelopment()
              ? "http://localhost:3000"
              : (EnvironmentConfig.getOptionalEnvVariable("DUST_US_URL") ??
                "https://dust.tt"),
          },
        ];
      // EU Global
      case "cell-00001":
        return [
          cell,
          {
            name: cell,
            region: "europe-west1",
            url: isDevelopment()
              ? "http://localhost:3000"
              : (EnvironmentConfig.getOptionalEnvVariable("DUST_EU_URL") ??
                "https://eu.dust.tt"),
          },
        ];
      // EU 2
      case "cell-00002":
        return [
          cell,
          {
            name: cell,
            region: "europe-west1",
            url: isDevelopment()
              ? "http://localhost:3000"
              : (EnvironmentConfig.getOptionalEnvVariable(
                  "DUST_CELL_00002_URL"
                ) ?? "https://eu2.dust.tt"),
          },
        ];
      default:
        // This ensures that if a new CellType is added, TypeScript will error until handled.
        assertNever(cell);
    }
  })
) satisfies Record<CellType, CellInfo>;

const MAIN_CELL: CellType = "cell-00000";
const ISOLATED_POC_CELL: CellInfo = {
  ...CELLS[MAIN_CELL],
  region: "asia-southeast1",
  url:
    EnvironmentConfig.getOptionalEnvVariable("NEXT_PUBLIC_DUST_API_URL") ?? "",
};
const isIsolatedPocCell = () =>
  EnvironmentConfig.getOptionalEnvVariable("DUST_POC_MODE") === "1";

/**
 * @cc [owner:jchen0824,label:security] poc-cell-isolation
 * When DUST_POC_MODE is 1, cell discovery and lookup MUST expose only the configured local
 * main cell in asia-southeast1, peer-cell sync MUST be disabled, and a missing local URL
 * MUST fail closed. Its URL comes from the public API URL already required by
 * the deployment, rather than the hosted main-cell catalog.
 */
export const config = {
  getCurrentCell: (): CellInfo => {
    const cell = EnvironmentConfig.getEnvVariable("CELL");
    if (!isCellType(cell)) {
      throw new Error(`Invalid cell: ${cell}`);
    }
    if (isIsolatedPocCell()) {
      if (cell !== MAIN_CELL) {
        throw new Error("The isolated POC must use the main cell");
      }
      if (EnvironmentConfig.getEnvVariable("REGION") !== "asia-southeast1") {
        throw new Error("The isolated POC must use the Singapore region");
      }
      if (!ISOLATED_POC_CELL.url) {
        throw new Error(
          "NEXT_PUBLIC_DUST_API_URL is required in the isolated POC"
        );
      }
    }
    return isIsolatedPocCell() ? ISOLATED_POC_CELL : CELLS[cell];
  },
  getLookupApiSecret: (): string => {
    return EnvironmentConfig.getEnvVariable("REGION_RESOLVER_SECRET");
  },
  getCellInfo(cell: CellType): CellInfo {
    // Existing WorkOS sessions may carry an old hosted-cell claim. Keep the
    // callback on this isolated deployment without exposing a hosted URL.
    return isIsolatedPocCell() ? this.getCurrentCell() : CELLS[cell];
  },
  getCellUrl(cell: CellType): string {
    return this.getCellInfo(cell).url;
  },
  getAllCells(): CellInfo[] {
    if (isIsolatedPocCell()) {
      return [this.getCurrentCell()];
    }
    return SUPPORTED_CELLS.map((cell) => this.getCellInfo(cell));
  },
  isMainCell(): boolean {
    return this.getCurrentCell().name === MAIN_CELL;
  },
  getOtherCells(): CellInfo[] {
    const currentCell = this.getCurrentCell();
    return this.getAllCells().filter((cell) => cell.name !== currentCell.name);
  },
  getDustCellSyncEnabled: (): boolean => {
    if (isIsolatedPocCell()) {
      return false;
    }
    return (
      EnvironmentConfig.getEnvVariable("CELL") !== MAIN_CELL || isDevelopment()
    );
  },
  getDustCellSyncMasterUrl: (): string => {
    return isIsolatedPocCell() ? ISOLATED_POC_CELL.url : CELLS[MAIN_CELL].url;
  },
};
