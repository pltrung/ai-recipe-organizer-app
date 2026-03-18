/**
 * Server-side pending merge proposal (stored in recipes.pending_merge).
 */

import type { RecipeLastDiff, RecipeDiffVersionEntry } from "./types";

export type PendingSourceSummary = {
  source_url: string;
  source_type: string;
  confidence: string;
};

export type PendingMergeV1 = {
  version: 1;
  created_at: string;
  synth_ok: boolean;
  source_summary: PendingSourceSummary;
  next_source_urls: string[];
  next_source_platforms: string[];
  next_sources: string[];
  next_raw_texts: string[];
  combined_text: string;
  source_extractions: unknown[] | null;
  /** Shown in review + committed on apply */
  diff: {
    summary: string;
    key_improvements: string[];
  };
  /** Set when synth_ok — committed on apply */
  last_diff: RecipeLastDiff | null;
  version_entry_apply: RecipeDiffVersionEntry | null;
  /** DB body fields when synth_ok — applied on "Apply changes" */
  row_update: {
    title: string;
    description: string;
    ingredients: unknown;
    steps: unknown;
    tips: unknown;
    substitutions: unknown;
    mistakes: unknown;
    techniques: unknown;
    estimated_time: string;
    servings: string;
    servings_base: number;
    recipe_quality: unknown;
    needs_user_input: boolean;
  } | null;
};

export function parsePendingMerge(raw: unknown): PendingMergeV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return null;
  if (typeof o.created_at !== "string") return null;
  return raw as unknown as PendingMergeV1;
}

export function emptyExtractionSlot(
  sourceLabel: string,
  sourceUrl: string,
  sourceType: string,
  rawSlice: string
) {
  return {
    source_url: sourceUrl || sourceLabel,
    source_type: sourceType,
    raw_text: rawSlice.slice(0, 8000),
    ingredient_candidates: [] as string[],
    step_candidates: [] as string[],
    tip_candidates: [] as string[],
  };
}
