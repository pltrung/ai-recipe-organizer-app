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
  ingredients_count?: number;
  steps_count?: number;
  /** Truncated preview for API / UI */
  raw_text?: string;
  error?: string;
  /** JSON-LD bypass without OpenAI */
  from_json_ld?: boolean;
};

export type IngestUrlOutcome = {
  report: SourceExtractionReport;
  recipe: ExtractedRecipeWithConfidence | null;
  rawForDb: string;
};

function logRawPreview(raw: string) {
  console.log(
    "[pipeline] raw_text length:",
    raw.length,
    "| preview:",
    raw.slice(0, 400).replace(/\s+/g, " ")
  );
}

export async function ingestUrl(
  url: string,
  openaiKey: string
): Promise<IngestUrlOutcome> {
  const u = url.trim();
  const { platform, strategy } = classifyLink(u);
  let raw = "";
  let confidence: Confidence = "medium";

  console.log("[pipeline] ========== SOURCE:", u, "==========");

  try {
    if (strategy === "html_parse") {
      const w = await extractWebsite(u);

      if (!w.ok || !w.raw_text?.trim()) {
        console.log(
          "[pipeline] website failed | ingredients: 0 | steps: 0 | OpenAI skipped"
        );
        console.log("[pipeline] ========== END SOURCE ==========");
        return {
          report: {
            source_url: u,
            platform,
            status: "failed",
            ingredients_count: 0,
            steps_count: 0,
            raw_text: w.debug?.preview?.slice(0, 500),
            error: w.error ?? "Extraction failed",
          },
          recipe: null,
          rawForDb: w.raw_text || "",
        };
      }

      raw = w.raw_text;
      confidence = w.confidence;
      logRawPreview(raw);

      if (
        w.recipeFromJsonLd &&
        (w.recipeFromJsonLd.ingredients.length > 0 ||
          w.recipeFromJsonLd.steps.length > 0)
      ) {
        const r = w.recipeFromJsonLd;
        console.log(
          "[pipeline] OpenAI BYPASS (JSON-LD) | full OpenAI raw response: (not used)"
        );
        console.log(
          "[pipeline] parsed ingredients:",
          r.ingredients.length,
          "| parsed steps:",
          r.steps.length
        );
        console.log("[pipeline] ========== END SOURCE ==========");
        return {
          report: {
            source_url: u,
            platform,
            status: "success",
            confidence: "high",
            ingredients_count: r.ingredients.length,
            steps_count: r.steps.length,
            raw_text: raw.slice(0, 500),
            from_json_ld: true,
          },
          recipe: { ...r, confidence: "high" },
          rawForDb: raw,
        };
      }
    } else if (strategy === "youtube") {
      const y = await strategyYoutube(u);
      if (!y?.raw_text?.trim()) {
        console.log("[pipeline] YouTube: no text");
        console.log("[pipeline] ========== END SOURCE ==========");
        return {
          report: {
            source_url: u,
            platform,
            status: "failed",
            ingredients_count: 0,
            steps_count: 0,
            error: "Could not read YouTube content",
          },
          recipe: null,
          rawForDb: "",
        };
      }
      raw = y.raw_text;
      confidence = y.confidence;
      logRawPreview(raw);
    } else {
      const r = strategyReelFallback(platform);
      raw = r.raw_text;
      confidence = r.confidence;
      logRawPreview(raw);
    }

    const extracted = await extractRecipe(raw, openaiKey);
    const hasContent =
      extracted.ingredients.length > 0 || extracted.steps.length > 0;

    console.log(
      "[pipeline] parsed ingredients:",
      extracted.ingredients.length,
      "| parsed steps:",
      extracted.steps.length
    );
    console.log("[pipeline] ========== END SOURCE ==========");

    if (!hasContent) {
      return {
        report: {
          source_url: u,
          platform,
          status: "failed",
          confidence,
          ingredients_count: 0,
          steps_count: 0,
          raw_text: raw.slice(0, 500),
          error: "No ingredients or steps derived",
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
        ingredients_count: extracted.ingredients.length,
        steps_count: extracted.steps.length,
        raw_text: raw.slice(0, 500),
      },
      recipe: { ...extracted, confidence },
      rawForDb: raw,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.log("[pipeline] error:", msg);
    console.log("[pipeline] ========== END SOURCE ==========");
    return {
      report: {
        source_url: u,
        platform,
        status: "failed",
        ingredients_count: 0,
        steps_count: 0,
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
  const label = `image:${index + 1}`;
  console.log("[pipeline] ========== SOURCE:", label, "==========");

  try {
    const img = await strategyImage(imageBase64, openaiKey);
    if (!img?.raw_text?.trim()) {
      console.log("[pipeline] ========== END SOURCE ==========");
      return {
        report: {
          source_url: label,
          platform: "image",
          status: "failed",
          ingredients_count: 0,
          steps_count: 0,
          error: "Could not read image",
        },
        recipe: null,
        rawForDb: "",
      };
    }
    logRawPreview(img.raw_text);
    const extracted = await extractRecipe(img.raw_text, openaiKey);
    const hasContent =
      extracted.ingredients.length > 0 || extracted.steps.length > 0;
    console.log(
      "[pipeline] parsed ingredients:",
      extracted.ingredients.length,
      "| steps:",
      extracted.steps.length
    );
    console.log("[pipeline] ========== END SOURCE ==========");

    if (!hasContent) {
      return {
        report: {
          source_url: label,
          platform: "image",
          status: "failed",
          confidence: img.confidence,
          ingredients_count: 0,
          steps_count: 0,
          raw_text: img.raw_text.slice(0, 500),
          error: "Could not extract recipe from image",
        },
        recipe: null,
        rawForDb: img.raw_text,
      };
    }
    return {
      report: {
        source_url: label,
        platform: "image",
        status: "success",
        confidence: img.confidence,
        ingredients_count: extracted.ingredients.length,
        steps_count: extracted.steps.length,
        raw_text: img.raw_text.slice(0, 500),
      },
      recipe: { ...extracted, confidence: img.confidence },
      rawForDb: img.raw_text,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Image error";
    console.log("[pipeline] ========== END SOURCE ==========");
    return {
      report: {
        source_url: label,
        platform: "image",
        status: "failed",
        ingredients_count: 0,
        steps_count: 0,
        error: msg,
      },
      recipe: null,
      rawForDb: "",
    };
  }
}
