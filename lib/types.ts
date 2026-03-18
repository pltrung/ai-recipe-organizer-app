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
  steps: string[];
  /** Chef tips / enhancements from merged sources */
  tips: string[];
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
}

export interface RecipeRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  ingredients: Record<string, unknown>;
  steps: Record<string, unknown>;
  tips?: unknown;
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
