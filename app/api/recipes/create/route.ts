import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { detectPlatform } from "@/lib/platformDetector";
import { fetchContent } from "@/lib/fetchContent";
import { extractRecipe } from "@/lib/aiExtractor";
import { mergeRecipes } from "@/lib/aiMerge";
import type { Recipe } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      urls: string[];
      user_id?: string;
      fallback?: { title: string; ingredients: string[]; steps: string[] };
    };
    const urls = body?.urls ?? [];
    const fallback = body?.fallback;

    if (fallback && Array.isArray(fallback.ingredients) && Array.isArray(fallback.steps)) {
      const supabase = createServerClient();
      const validUrls = urls.filter((u: string) => String(u).trim());
      const { data, error } = await supabase
        .from("recipes")
        .insert({
          user_id: body.user_id ?? null,
          title: fallback.title || "Untitled Recipe",
          description: "",
          ingredients: fallback.ingredients,
          steps: fallback.steps,
          estimated_time: "—",
          servings: "—",
          source_urls: validUrls,
          source_platforms: validUrls.map((u: string) => detectPlatform(u)),
          raw_text: null,
        })
        .select("id")
        .single();
      if (error) {
        console.error(error);
        return NextResponse.json({ error: "Failed to save recipe" }, { status: 500 });
      }
      return NextResponse.json({ id: data.id });
    }

    if (!Array.isArray(urls) || urls.length === 0) {
      return NextResponse.json({ error: "Missing or empty urls" }, { status: 400 });
    }
    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return NextResponse.json({ error: "OpenAI not configured" }, { status: 500 });
    }

    const sourceUrls: string[] = [];
    const sourcePlatforms: string[] = [];
    const extractedList: Awaited<ReturnType<typeof extractRecipe>>[] = [];
    const rawTextParts: string[] = [];

    for (const url of urls) {
      const u = String(url).trim();
      if (!u) continue;
      sourceUrls.push(u);
      sourcePlatforms.push(detectPlatform(u));
      const raw = await fetchContent(u);
      rawTextParts.push(raw);
      const recipe = await extractRecipe(raw, openaiKey);
      extractedList.push(recipe);
    }

    const validRecipes = extractedList.filter(Boolean) as import("@/lib/types").ExtractedRecipe[];
    if (validRecipes.length === 0) {
      return NextResponse.json(
        { error: "Could not extract any recipe from the links" },
        { status: 422 }
      );
    }

    const merged = await mergeRecipes(validRecipes, openaiKey);
    if (!merged) {
      return NextResponse.json({ error: "Could not merge recipes" }, { status: 422 });
    }

    const recipeRow: Omit<Recipe, "id" | "created_at"> = {
      user_id: body.user_id ?? null,
      title: merged.title,
      description: merged.description,
      ingredients: merged.ingredients,
      steps: merged.steps,
      estimated_time: merged.estimated_time,
      servings: merged.servings,
      source_urls: sourceUrls,
      source_platforms: sourcePlatforms,
      raw_text: rawTextParts.join("\n\n---\n\n"),
    };

    const supabase = createServerClient();
    const { data, error } = await supabase.from("recipes").insert({
      user_id: recipeRow.user_id,
      title: recipeRow.title,
      description: recipeRow.description,
      ingredients: recipeRow.ingredients,
      steps: recipeRow.steps,
      estimated_time: recipeRow.estimated_time,
      servings: recipeRow.servings,
      source_urls: recipeRow.source_urls,
      source_platforms: recipeRow.source_platforms,
      raw_text: recipeRow.raw_text,
    }).select("id").single();

    if (error) {
      console.error(error);
      return NextResponse.json({ error: "Failed to save recipe" }, { status: 500 });
    }
    return NextResponse.json({ id: data.id });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
