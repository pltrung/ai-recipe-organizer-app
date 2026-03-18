import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { classifyLink } from "@/lib/classifyLink";
import { detectPlatform } from "@/lib/platformDetector";
import { ingestUrl, ingestImage } from "@/lib/sourcePipeline";
import { mergeRecipesWithConfidence } from "@/lib/aiMerge";
import type { Recipe } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      urls?: string[];
      images?: string[];
      user_id?: string;
      dish_name?: string;
      fallback?: { title: string; ingredients: string[]; steps: string[] };
    };
    const urls = body?.urls ?? [];
    const images = body?.images ?? [];
    const fallback = body?.fallback;
    const dishName = body?.dish_name?.trim();

    if (
      fallback &&
      Array.isArray(fallback.ingredients) &&
      Array.isArray(fallback.steps)
    ) {
      const supabase = createServerClient();
      const validUrls = urls.filter((u: string) => String(u).trim());
      const { data, error } = await supabase
        .from("recipes")
        .insert({
          user_id: body.user_id ?? null,
          title: fallback.title || dishName || "Untitled Recipe",
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
        return NextResponse.json(
          { error: "Failed to save recipe" },
          { status: 500 }
        );
      }
      return NextResponse.json({
        id: data.id,
        from_reel: validUrls.some(
          (u: string) => classifyLink(u).strategy === "reel_fallback"
        ),
      });
    }

    const hasUrls = Array.isArray(urls) && urls.some((u) => String(u).trim());
    const hasImages = Array.isArray(images) && images.length > 0;
    if (!hasUrls && !hasImages) {
      return NextResponse.json(
        { error: "Add at least one link or image." },
        { status: 400 }
      );
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return NextResponse.json(
        { error: "OpenAI not configured" },
        { status: 500 }
      );
    }

    const sourceReports: import("@/lib/sourcePipeline").SourceExtractionReport[] =
      [];
    const successfulRecipes: import("@/lib/types").ExtractedRecipeWithConfidence[] =
      [];
    const rawTextParts: string[] = [];
    const sourceUrls: string[] = [];
    const sourcePlatforms: string[] = [];
    let hasReelInput = false;

    for (const url of urls) {
      const u = String(url).trim();
      if (!u) continue;
      if (classifyLink(u).strategy === "reel_fallback") hasReelInput = true;
      sourceUrls.push(u);
      sourcePlatforms.push(classifyLink(u).platform);

      const outcome = await ingestUrl(u, openaiKey);
      sourceReports.push(outcome.report);
      if (outcome.rawForDb) rawTextParts.push(`--- ${u} ---\n${outcome.rawForDb}`);
      if (outcome.recipe) successfulRecipes.push(outcome.recipe);
    }

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img || typeof img !== "string") continue;
      sourcePlatforms.push("image");
      const outcome = await ingestImage(img, i, openaiKey);
      sourceReports.push(outcome.report);
      if (outcome.rawForDb) rawTextParts.push(`--- image ${i + 1} ---\n${outcome.rawForDb}`);
      if (outcome.recipe) successfulRecipes.push(outcome.recipe);
    }

    const extractedCount = sourceReports.filter((r) => r.status === "success").length;
    const totalCount = sourceReports.length;

    if (successfulRecipes.length === 0) {
      return NextResponse.json(
        {
          error:
            "We couldn't extract a usable recipe from any source. Add ingredients and steps below—or try different links.",
          has_reel_input: hasReelInput,
          sources: sourceReports,
          extracted_count: extractedCount,
          total_count: totalCount,
        },
        { status: 422 }
      );
    }

    let merged: import("@/lib/types").ExtractedRecipe | null = null;
    if (successfulRecipes.length === 1) {
      merged = successfulRecipes[0];
    } else {
      merged = await mergeRecipesWithConfidence(successfulRecipes, openaiKey);
      if (!merged) {
        merged = successfulRecipes[0];
      }
    }

    const title = dishName && dishName.length > 0 ? dishName : merged!.title;
    const recipeRow: Omit<Recipe, "id" | "created_at"> = {
      user_id: body.user_id ?? null,
      title,
      description: merged!.description,
      ingredients: merged!.ingredients,
      steps: merged!.steps,
      estimated_time: merged!.estimated_time,
      servings: merged!.servings,
      source_urls: sourceUrls,
      source_platforms: sourcePlatforms,
      raw_text: rawTextParts.join("\n\n") || undefined,
    };

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("recipes")
      .insert({
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
      })
      .select("id")
      .single();

    if (error) {
      console.error(error);
      return NextResponse.json(
        { error: "Failed to save recipe" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      id: data.id,
      from_reel: hasReelInput,
      sources: sourceReports,
      extracted_count: extractedCount,
      total_count: totalCount,
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
