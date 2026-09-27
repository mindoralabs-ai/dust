import type { RegionType } from "@app/types/region";
import { assertNever } from "@app/types/shared/utils/assert_never";

export const getRegionDisplay = (region: RegionType): string => {
  switch (region) {
    case "europe-west1":
      return "🇪🇺 EU";
    case "us-central1":
      return "🇺🇸 US";
    case "asia-southeast1":
      return "🇸🇬 SG";
    default:
      assertNever(region);
  }
};

export const getRegionChipColor = (
  region: RegionType
): "highlight" | "success" => {
  switch (region) {
    case "europe-west1":
      return "highlight";
    case "us-central1":
      return "success";
    case "asia-southeast1":
      return "success";
    default:
      assertNever(region);
  }
};
