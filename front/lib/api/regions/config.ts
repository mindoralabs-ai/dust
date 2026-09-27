import type { RegionType } from "@app/types/region";
import { isDevelopment } from "@app/types/shared/env";
import { EnvironmentConfig } from "@app/types/shared/utils/config";

export const REGION_TIMEZONES: Record<RegionType, string> = {
  "europe-west1": "Europe/Paris",
  "us-central1": "America/New_York",
  "asia-southeast1": "Asia/Singapore",
};

/**
 * @cc [owner:jchen0824,label:security] poc-no-region-sync
 * The isolated Singapore POC MUST NOT sync region data to Dust's hosted US service.
 */
export const config = {
  getCurrentRegion: (): RegionType => {
    return EnvironmentConfig.getEnvVariable("REGION") as RegionType;
  },
  getDustRegionSyncEnabled: (): boolean => {
    if (EnvironmentConfig.getOptionalEnvVariable("DUST_POC_MODE") === "1") {
      return false;
    }
    return (
      EnvironmentConfig.getEnvVariable("REGION") !== "us-central1" ||
      isDevelopment()
    );
  },
  getDustRegionSyncMasterUrl: (): string => {
    return EnvironmentConfig.getEnvVariable("DUST_US_URL");
  },
};
