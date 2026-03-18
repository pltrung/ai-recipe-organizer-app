/**
 * Recipe synthesis: 4-phase pipeline (extract → dish profile → ingredients → steps).
 * See recipeSynthesisPhased.ts.
 */

import type { ExtractedRecipeWithConfidence, SynthesisDbPayload } from "./types";
import { RAW_TEXT_JOINER } from "./recipeSourceHistory";
import {
  synthesizeRecipePhased,
  chunksFromHistory,
  chunksFromVersions,
  type SourceChunk,
  type SynthesisStyle,
} from "./recipeSynthesisPhased";

export type { SynthesisDbPayload } from "./types";

export {
  synthesizeRecipePhased,
  chunksFromHistory,
  chunksFromVersions,
} from "./recipeSynthesisPhased";
export type { PerSourceExtraction, SynthesisStyle } from "./recipeSynthesisPhased";

export type SynthesisOptions = {
  sources?: string[];
  raw_texts?: string[];
  sourceConfidences?: import("./sourceSynthesisConfidence").SourceConfidence[];
  platforms?: string[];
  synthesisStyle?: SynthesisStyle;
};

/**
 * Full synthesis from joined raw corpus or parallel source chunks.
 */
export async function synthesizeRecipeFromCombinedRaw(
  combinedText: string,
  openaiApiKey: string,
  fallbackTitle = "Recipe",
  options?: SynthesisOptions
): Promise<SynthesisDbPayload | null> {
  let chunks: SourceChunk[];
  if (
    options?.raw_texts &&
    options.raw_texts.some((t) => String(t).trim())
  ) {
    chunks = chunksFromHistory(
      options.sources?.map((s) => String(s)) ?? [],
      options.raw_texts.map((t) => String(t)),
      options.sourceConfidences,
      options.platforms
    );
  } else {
    const parts = combinedText
      .split(RAW_TEXT_JOINER)
      .map((s) => s.trim())
      .filter(Boolean);
    chunks = parts.map((text, i) => ({
      label: `Source ${i + 1}`,
      text,
    }));
  }
  if (chunks.length === 0 && combinedText.trim()) {
    chunks = [{ label: "Source 1", text: combinedText.trim().slice(0, 120_000) }];
  }
  const r = await synthesizeRecipePhased(chunks, openaiApiKey, fallbackTitle, {
    synthesisStyle: options?.synthesisStyle,
  });
  return r?.payload ?? null;
}

/** Same as synthesizeRecipeFromCombinedRaw but includes per-source extractions for storage. */
export async function synthesizeRecipeFromCombinedRawWithExtractions(
  combinedText: string,
  openaiApiKey: string,
  fallbackTitle = "Recipe",
  options?: SynthesisOptions
) {
  let chunks: SourceChunk[];
  if (
    options?.raw_texts &&
    options.raw_texts.some((t) => String(t).trim())
  ) {
    chunks = chunksFromHistory(
      options.sources?.map((s) => String(s)) ?? [],
      options.raw_texts.map((t) => String(t)),
      options.sourceConfidences,
      options.platforms
    );
  } else {
    const parts = combinedText
      .split(RAW_TEXT_JOINER)
      .map((s) => s.trim())
      .filter(Boolean);
    chunks = parts.map((text, i) => ({
      label: `Source ${i + 1}`,
      text,
    }));
  }
  if (chunks.length === 0 && combinedText.trim()) {
    chunks = [{ label: "Source 1", text: combinedText.trim().slice(0, 120_000) }];
  }
  return synthesizeRecipePhased(chunks, openaiApiKey, fallbackTitle, {
    synthesisStyle: options?.synthesisStyle,
  });
}

export async function synthesizeRecipeFromVersions(
  sources: ExtractedRecipeWithConfidence[],
  openaiApiKey: string
): Promise<SynthesisDbPayload | null> {
  if (sources.length === 0 || !openaiApiKey?.trim()) return null;
  const chunks = chunksFromVersions(sources);
  const title = sources[0]?.title?.trim() || "Recipe";
  const r = await synthesizeRecipePhased(chunks, openaiApiKey, title);
  return r?.payload ?? null;
}
