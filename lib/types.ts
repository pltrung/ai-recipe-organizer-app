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

export interface ExtractedRecipe {
  title: string;
  description: string;
  ingredients: string[];
  steps: string[];
  estimated_time: string;
  servings: string;
}

export interface ExtractedRecipeWithConfidence extends ExtractedRecipe {
  confidence: Confidence;
}

export interface Recipe {
  id?: string;
  user_id?: string | null;
  title: string;
  description: string;
  ingredients: string[];
  steps: string[];
  estimated_time: string;
  servings: string;
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
  estimated_time: string;
  servings: string;
  source_urls: Record<string, unknown>;
  source_platforms: Record<string, unknown>;
  raw_text: string | null;
  created_at: string;
  updated_at?: string;
  needs_user_input?: boolean;
}
