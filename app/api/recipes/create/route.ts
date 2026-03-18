import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { classifyLink } from "@/lib/classifyLink";
import { detectPlatform } from "@/lib/platformDetector";
import { fetchContent } from "@/lib/extractionRouter";
import { extractRecipe } from "@/lib/aiExtractor";
import { mergeRecipesWithConfidence } from "@/lib/aiMerge";
import type { Recipe, ExtractedRecipeWithConfidence } from "@/lib/types";

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

    const sourceUrls: string[] = [];
    const sourcePlatforms: string[] = [];
    const extractedWithConfidence: ExtractedRecipeWithConfidence[] = [];
    const rawTextParts: string[] = [];
    let hasReelInput = false;

    for (const url of urls) {
      const u = String(url).trim();
      if (!u) continue;
      const classification = classifyLink(u);
      if (classification.strategy === "reel_fallback") hasReelInput = true;
      sourceUrls.push(u);
      sourcePlatforms.push(classification.platform);

      const result = await fetchContent({ type: "url", value: u }, openaiKey);
      if (!result) continue;
      rawTextParts.push(result.raw_text);

      const recipe = await extractRecipe(result.raw_text, openaiKey);
      if (recipe && (recipe.ingredients.length > 0 || recipe.steps.length > 0)) {
        extractedWithConfidence.push({
          ...recipe,
          confidence: result.confidence,
        });
      } else if (recipe) {
        extractedWithConfidence.push({
          ...recipe,
          confidence: result.confidence,
        });
      }
    }

    for (const imageBase64 of images) {
      if (!imageBase64 || typeof imageBase64 !== "string") continue;
      sourcePlatforms.push("image");
      const result = await fetchContent(
        { type: "image", value: imageBase64 },
        openaiKey
      );
      if (!result) continue;
      rawTextParts.push(result.raw_text);
      const recipe = await extractRecipe(result.raw_text, openaiKey);
      if (recipe) {
        extractedWithConfidence.push({
          ...recipe,
          confidence: result.confidence,
        });
      }
    }

    let merged: import("@/lib/types").ExtractedRecipe | null = null;
    if (extractedWithConfidence.length > 0) {
      merged = await mergeRecipesWithConfidence(extractedWithConfidence, openaiKey);
    }

    if (!merged) {
      return NextResponse.json(
        {
          error:
            "We couldn't extract a full recipe from your links or images. Use the form below to add ingredients and steps—we'll save it for you.",
          has_reel_input: hasReelInput,
        },
        { status: 422 }
      );
    }

    const title = dishName && dishName.length > 0 ? dishName : merged.title;
    const recipeRow: Omit<Recipe, "id" | "created_at"> = {
      user_id: body.user_id ?? null,
      title,
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
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Server error" },
      { status: 500 }
    );
  }
}
