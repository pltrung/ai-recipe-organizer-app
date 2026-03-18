import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { detectPlatform } from "@/lib/platformDetector";
import { extractRecipe } from "@/lib/aiExtractor";

const MIN_RAW_LENGTH = 30;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      raw_text?: string;
      source_url?: string;
      platform?: string;
    };
    const rawText = typeof body?.raw_text === "string" ? body.raw_text.trim() : "";
    const sourceUrl = typeof body?.source_url === "string" ? body.source_url.trim() : "";
    const platformFromClient = typeof body?.platform === "string" ? body.platform.trim() : "";

    const openaiKey = process.env.OPENAI_API_KEY;
    const supabase = createServerClient();

    const sourceUrls = sourceUrl ? [sourceUrl] : [];
    const sourcePlatforms = sourceUrl
      ? [detectPlatform(sourceUrl)]
      : [platformFromClient || "website"];

    let title = "Untitled Recipe";
    let description = "";
    let ingredients: string[] = [];
    let steps: string[] = [];
    let estimatedTime = "—";
    let servings = "—";

    if (rawText.length >= MIN_RAW_LENGTH && openaiKey) {
      const extracted = await extractRecipe(rawText, openaiKey);
      if (
        extracted &&
        (extracted.ingredients.length > 0 || extracted.steps.length > 0)
      ) {
        title = extracted.title;
        description = extracted.description ?? "";
        ingredients = extracted.ingredients ?? [];
        steps = extracted.steps ?? [];
        estimatedTime = extracted.estimated_time ?? "—";
        servings = extracted.servings ?? "—";
      }
    }

    const { data, error } = await supabase
      .from("recipes")
      .insert({
        user_id: null,
        title,
        description,
        ingredients,
        steps,
        estimated_time: estimatedTime,
        servings,
        source_urls: sourceUrls,
        source_platforms: sourcePlatforms,
        raw_text: rawText || null,
      })
      .select("id")
      .single();

    if (error) {
      console.error("extract-from-extension insert error:", error);
      return NextResponse.json(
        { error: "Failed to save recipe" },
        { status: 500 }
      );
    }

    return NextResponse.json({ recipeId: data.id });
  } catch (e) {
    console.error("extract-from-extension error:", e);
    return NextResponse.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}
