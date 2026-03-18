import { classifyLink } from "./classifyLink";
import { extractWebsite } from "./websiteExtract";
import { strategyYoutube, strategyReelFallback } from "./extractionStrategies";
import { extractRecipe } from "./aiExtractor";
import type { Confidence, ExtractedRecipeWithConfidence } from "./types";

export type SourceExtractionReport = {
  source_url: string;
  platform: string;
  status: "success" | "failed";
  confidence?: string;
  /** Truncated for API response */
  raw_text?: string;
  error?: string;
};

export type IngestUrlOutcome = {
  report: SourceExtractionReport;
  recipe: ExtractedRecipeWithConfidence | null;
  rawForDb: string;
};

export async function ingestUrl(
  url: string,
  openaiKey: string
): Promise<IngestUrlOutcome> {
  const u = url.trim();
  const { platform, strategy } = classifyLink(u);
  let raw = "";
  let confidence: Confidence = "medium";

  try {
    if (strategy === "html_parse") {
      const w = await extractWebsite(u);
      if (!w.ok) {
        return {
          report: {
            source_url: u,
            platform,
            status: "failed",
            error: w.error ?? "Extraction failed",
            raw_text: w.debug.preview.slice(0, 500),
          },
          recipe: null,
          rawForDb: "",
        };
      }
      raw = w.raw_text;
      confidence = w.confidence;
    } else if (strategy === "youtube") {
      const y = await strategyYoutube(u);
      if (!y?.raw_text || y.raw_text.length < 30) {
        return {
          report: {
            source_url: u,
            platform,
            status: "failed",
            error: "Could not read YouTube transcript or description",
          },
          recipe: null,
          rawForDb: "",
        };
      }
      raw = y.raw_text;
      confidence = y.confidence;
    } else {
      const r = strategyReelFallback(platform);
      raw = r.raw_text;
      confidence = r.confidence;
    }

    const extracted = await extractRecipe(raw, openaiKey);
    const hasContent =
      extracted &&
      (extracted.ingredients.length > 0 || extracted.steps.length > 0);

    if (!hasContent) {
      return {
        report: {
          source_url: u,
          platform,
          status: "failed",
          confidence,
          raw_text: raw.slice(0, 500),
          error:
            "Could not build ingredients/steps from this source (try another link or manual entry)",
        },
        recipe: null,
        rawForDb: raw,
      };
    }

    return {
      report: {
        source_url: u,
        platform,
        status: "success",
        confidence,
        raw_text: raw.slice(0, 500),
      },
      recipe: { ...extracted!, confidence },
      rawForDb: raw,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return {
      report: {
        source_url: u,
        platform,
        status: "failed",
        error: msg,
      },
      recipe: null,
      rawForDb: "",
    };
  }
}

export async function ingestImage(
  imageBase64: string,
  index: number,
  openaiKey: string
): Promise<IngestUrlOutcome> {
  const { strategyImage } = await import("./extractionStrategies");
  try {
    const img = await strategyImage(imageBase64, openaiKey);
    if (!img?.raw_text) {
      return {
        report: {
          source_url: `image:${index + 1}`,
          platform: "image",
          status: "failed",
          error: "Could not read image",
        },
        recipe: null,
        rawForDb: "",
      };
    }
    const extracted = await extractRecipe(img.raw_text, openaiKey);
    const hasContent =
      extracted &&
      (extracted.ingredients.length > 0 || extracted.steps.length > 0);
    if (!hasContent) {
      return {
        report: {
          source_url: `image:${index + 1}`,
          platform: "image",
          status: "failed",
          confidence: img.confidence,
          raw_text: img.raw_text.slice(0, 500),
          error: "Could not extract recipe from image",
        },
        recipe: null,
        rawForDb: img.raw_text,
      };
    }
    return {
      report: {
        source_url: `image:${index + 1}`,
        platform: "image",
        status: "success",
        confidence: img.confidence,
        raw_text: img.raw_text.slice(0, 500),
      },
      recipe: { ...extracted!, confidence: img.confidence },
      rawForDb: img.raw_text,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Image error";
    return {
      report: {
        source_url: `image:${index + 1}`,
        platform: "image",
        status: "failed",
        error: msg,
      },
      recipe: null,
      rawForDb: "",
    };
  }
}
