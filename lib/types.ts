export type Platform =
  | "youtube"
  | "tiktok"
  | "instagram"
  | "facebook"
  | "xiaohongshu"
  | "website";

/** Input type for the universal ingestion system */
export type InputType = "url" | "image";

/** Link content type (video, short, reel, post, page) */
export type LinkContentType = "video" | "short" | "reel" | "post" | "page";

/** Extraction strategy to use */
export type ExtractionStrategy = "html_parse" | "youtube" | "reel_fallback" | "image";

/** Confidence level of extracted content */
export type Confidence = "high" | "medium" | "low";

export interface LinkClassification {
  platform: Platform;
  type: LinkContentType;
  strategy: ExtractionStrategy;
}

export interface ExtractionResult {
  raw_text: string;
  confidence: Confidence;
  source_label?: string; // e.g. "YouTube video", "Blog"
}

/** Parsed ingredient for scaling (DB + extract + merge) */
export interface StructuredIngredient {
  quantity: number | null;
  unit: string;
  name: string;
  /** Full line as captured (fallback when unscaled) */
  original: string;
}

export interface ScaledIngredient extends StructuredIngredient {
  scaledQuantity: number | null;
}

/** Structured cooking step (final saved shape) */
export type RecipeStep = {
  title: string;
  instructions: string;
  time: string;
  tools: string[];
  goal: string;
  /** When set (synthesis), preferred for display ordering */
  time_minutes?: number;
  /** Inline cautions (new synthesis) */
  warnings?: string[];
};

/** Substitution groups — new shape + legacy original/alternatives */
export type RecipeSubstitutionEntry = {
  /** Primary ingredient name */
  ingredient: string;
  options: string[];
  note?: string;
  /** Legacy DB rows */
  original?: string;
  alternatives?: string[];
};

/** Chef-quality metadata from phased synthesis */
export type RecipeQualityMeta = {
  dish_taxonomy: string;
  /** Cuisine label from dish profile (e.g. Vietnamese, Italian) */
  cuisine?: string;
  synthesis_style: string;
  variant_notes: string[];
  core_rationale: { name: string; why: string }[];
  critical_tips: string[];
  avoid_mistakes: string[];
  ingredient_roles?: { name: string; role: string }[];
};

/** Payload from synthesis before DB merge */
export type SynthesisDbPayload = {
  title: string;
  description: string;
  ingredients: { core: StructuredIngredient[]; optional: StructuredIngredient[] };
  steps: RecipeStep[];
  tips: string[];
  substitutionsDetailed: RecipeSubstitutionEntry[];
  mistakes: string[];
  techniques: string[];
  estimated_time: string;
  servings: string;
  servings_base: number;
  recipe_quality: RecipeQualityMeta | null;
};

export interface ExtractedRecipe {
  title: string;
  description: string;
  ingredients: StructuredIngredient[];
  steps: string[];
  estimated_time: string;
  /** Human-readable, e.g. "4 servings" */
  servings: string;
  /** Numeric base for scaling; default 1 */
  servings_base: number;
}

export interface ExtractedRecipeWithConfidence extends ExtractedRecipe {
  confidence: Confidence;
}

/** Grouped ingredients; legacy rows may use string[] items */
export type RecipeIngredientsGrouped = {
  core: StructuredIngredient[];
  optional: StructuredIngredient[];
};

export interface Recipe {
  id?: string;
  user_id?: string | null;
  title: string;
  description: string;
  ingredients: RecipeIngredientsGrouped;
  steps: RecipeStep[];
  /** Chef tips / enhancements from merged sources */
  tips: string[];
  /** Structured substitution groups (legacy rows may be string-only) */
  substitutions: RecipeSubstitutionEntry[];
  estimated_time: string;
  servings: string;
  /** Base serving count for ingredient scaling */
  servings_base: number;
  source_urls: string[];
  source_platforms: string[];
  raw_text?: string;
  created_at?: string;
  updated_at?: string;
  /** True when recipe is a draft (weak capture); show empty-state CTA */
  needs_user_input?: boolean;
  /** AI re-synthesis failed after a new source was saved; recipe body may be stale */
  needs_review?: boolean;
  /** Per-capture source label (URL etc.), parallel to raw_texts */
  sources?: string[];
  /** Raw text per source; combined with --- for full re-synthesis */
  raw_texts?: string[];
  /** Latest merge diff (structured + AI summary) */
  last_diff?: RecipeLastDiff | null;
  /** Rolling diff history (newest first), max ~10 */
  versions?: RecipeDiffVersionEntry[];
  /** Common mistakes to avoid */
  mistakes: string[];
  /** Named techniques worth highlighting */
  techniques: string[];
  /** Dish taxonomy, variants, core rationale, critical tips (synthesis v2) */
  recipe_quality?: RecipeQualityMeta | null;
}

export type RecipeDiffStructured = {
  added_core: string[];
  removed_core: string[];
  added_optional: string[];
  removed_optional: string[];
  moved_core_to_optional: string[];
  moved_optional_to_core: string[];
  steps_new: string[];
  steps_removed: string[];
  steps_modified: { before: string; after: string }[];
  new_tips: string[];
  removed_tips: string[];
  new_mistakes: string[];
  removed_mistakes: string[];
  new_techniques: string[];
  removed_techniques: string[];
};

/** Stored on recipe after a successful re-synthesis from a new source */
export type RecipeLastDiff = {
  at: string;
  source_count_after: number;
  summary: string;
  /** Authenticity, technique, flavor — primary UX */
  key_improvements: string[];
  /** Legacy rows only */
  ingredient_changes?: string[];
  step_changes?: string[];
  new_insights?: string[];
  structured?: RecipeDiffStructured;
};

export type RecipeDiffVersionEntry = {
  at: string;
  source_count_after: number;
  summary: string;
  key_improvements: string[];
  ingredient_changes?: string[];
  step_changes?: string[];
  new_insights?: string[];
};

export interface RecipeRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  ingredients: Record<string, unknown>;
  steps: Record<string, unknown>;
  tips?: unknown;
  substitutions?: unknown;
  mistakes?: unknown;
  techniques?: unknown;
  estimated_time: string;
  servings: string;
  servings_base?: number;
  source_urls: Record<string, unknown>;
  source_platforms: Record<string, unknown>;
  raw_text: string | null;
  created_at: string;
  updated_at?: string;
  needs_user_input?: boolean;
}
