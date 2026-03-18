export type Platform =
  | "youtube"
  | "tiktok"
  | "instagram"
  | "facebook"
  | "xiaohongshu"
  | "website";

export interface ExtractedRecipe {
  title: string;
  description: string;
  ingredients: string[];
  steps: string[];
  estimated_time: string;
  servings: string;
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
}
