import { classifyLink } from "./classifyLink";
import type { SourceExtractionReport } from "./sourcePipeline";

/** Finer than extract Confidence — drives core vs optional weighting in synthesis */
export type SourceConfidence = "high" | "medium_high" | "medium" | "low";

export function confidenceFromWebsiteIngest(
  url: string,
  report: Pick<SourceExtractionReport, "from_json_ld" | "ingredients_count">,
  rawLen: number
): SourceConfidence {
  if (report.from_json_ld) return "high";
  const { strategy } = classifyLink(url);
  if (strategy === "reel_fallback") {
    return rawLen > 4000 ? "medium" : "low";
  }
  if (strategy === "youtube") {
    return rawLen > 2800 ? "medium_high" : "medium";
  }
  if ((report.ingredients_count ?? 0) >= 5 && rawLen > 600) return "high";
  return rawLen > 1500 ? "medium_high" : "medium";
}

export function confidenceFromImageIngest(rawLen: number): SourceConfidence {
  return rawLen > 1200 ? "medium" : "low";
}

export function confidenceFromPlatformRaw(
  platform: string,
  rawLen: number
): SourceConfidence {
  const p = String(platform || "").toLowerCase();
  if (p === "image") return confidenceFromImageIngest(rawLen);
  if (
    p === "tiktok" ||
    p === "instagram" ||
    p === "facebook" ||
    p === "xiaohongshu"
  ) {
    return rawLen > 4500 ? "medium" : "low";
  }
  if (p === "youtube") return rawLen > 2800 ? "medium_high" : "medium";
  if (p === "website") return rawLen > 1200 ? "high" : "medium_high";
  return "medium";
}
