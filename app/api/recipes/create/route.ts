import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { classifyLink } from "@/lib/classifyLink";
import { detectPlatform } from "@/lib/platformDetector";
import { ingestUrl, ingestImage } from "@/lib/sourcePipeline";
import {
  mergeRecipesIntelligent,
  mergedOutputToDbRow,
} from "@/lib/aiMerge";
import { parseIngredientLine } from "@/lib/ingredientParser";

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
          ingredients: {
            core: fallback.ingredients.map((s: string) =>
              parseIngredientLine(String(s).trim())
            ),
            optional: [],
          },
          tips: [] as string[],
          steps: fallback.steps,
          estimated_time: "—",
          servings: "1 serving",
          servings_base: 1,
          source_urls: validUrls,
          source_platforms: validUrls.map((u: string) => detectPlatform(u)),
          raw_text: null,
          needs_user_input: false,
          updated_at: new Date().toISOString(),
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

    const urlList = urls.map((u) => String(u).trim()).filter(Boolean);
    for (const u of urlList) {
      if (classifyLink(u).strategy === "reel_fallback") hasReelInput = true;
      sourceUrls.push(u);
      sourcePlatforms.push(classifyLink(u).platform);
    }

    const urlResults = await Promise.allSettled(
      urlList.map((u) => ingestUrl(u, openaiKey))
    );

    for (let i = 0; i < urlList.length; i++) {
      const u = urlList[i];
      const settled = urlResults[i];
      if (settled.status === "fulfilled") {
        const outcome = settled.value;
        sourceReports.push(outcome.report);
        if (outcome.rawForDb)
          rawTextParts.push(`--- ${u} ---\n${outcome.rawForDb}`);
        if (outcome.recipe) successfulRecipes.push(outcome.recipe);
      } else {
        const reason =
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason ?? "Unknown error");
        sourceReports.push({
          source_url: u,
          platform: classifyLink(u).platform,
          status: "failed",
          ingredients_count: 0,
          steps_count: 0,
          error: reason,
        });
      }
    }

    const imageEntries = images
      .map((img, i) => ({ img, i }))
      .filter(
        (x): x is { img: string; i: number } =>
          Boolean(x.img) && typeof x.img === "string"
      );
    for (const _ of imageEntries) sourcePlatforms.push("image");

    const imageResults = await Promise.allSettled(
      imageEntries.map(({ img, i }) => ingestImage(img, i, openaiKey))
    );

    for (let j = 0; j < imageEntries.length; j++) {
      const { i } = imageEntries[j];
      const settled = imageResults[j];
      if (settled.status === "fulfilled") {
        const outcome = settled.value;
        sourceReports.push(outcome.report);
        if (outcome.rawForDb)
          rawTextParts.push(`--- image ${i + 1} ---\n${outcome.rawForDb}`);
        if (outcome.recipe) successfulRecipes.push(outcome.recipe);
      } else {
        const reason =
          settled.reason instanceof Error
            ? settled.reason.message
            : String(settled.reason ?? "Unknown error");
        sourceReports.push({
          source_url: `image:${i + 1}`,
          platform: "image",
          status: "failed",
          ingredients_count: 0,
          steps_count: 0,
          error: reason,
        });
      }
    }

    const extractedCount = sourceReports.filter((r) => r.status === "success").length;
    const totalCount = sourceReports.length;

    if (successfulRecipes.length === 0) {
      const supabase = createServerClient();
      const draftTitle = dishName?.length ? dishName : "Draft Recipe";
      const { data, error } = await supabase
        .from("recipes")
        .insert({
          user_id: body.user_id ?? null,
          title: draftTitle,
          description: "",
          ingredients: { core: [], optional: [] },
          tips: [] as string[],
          steps: [],
          estimated_time: "—",
          servings: "1 serving",
          servings_base: 1,
          source_urls: sourceUrls,
          source_platforms: sourcePlatforms,
          raw_text: rawTextParts.join("\n\n") || null,
          needs_user_input: true,
          updated_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (error) {
        console.error(error);
        return NextResponse.json(
          { error: "Failed to save draft recipe" },
          { status: 500 }
        );
      }
      return NextResponse.json({
        id: data.id,
        from_reel: hasReelInput,
        sources: sourceReports,
        extracted_count: extractedCount,
        total_count: totalCount,
        is_draft: true,
        message:
          "Saved as draft. Open the recipe to add sources or edit — no source returned structured ingredients and steps.",
      });
    }

    let mergedOut =
      (await mergeRecipesIntelligent(successfulRecipes, openaiKey)) ??
      null;
    if (!mergedOut) {
      mergedOut = await mergeRecipesIntelligent(
        [successfulRecipes[0]],
        openaiKey
      );
    }
    const dbPayload = mergedOutputToDbRow(mergedOut!);

    const title =
      dishName && dishName.length > 0 ? dishName : dbPayload.title;
    const recipeRow = {
      user_id: body.user_id ?? null,
      title,
      description: dbPayload.description,
      ingredients: dbPayload.ingredients,
      steps: dbPayload.steps,
      tips: dbPayload.tips,
      estimated_time: dbPayload.estimated_time,
      servings: dbPayload.servings,
      servings_base: dbPayload.servings_base,
      source_urls: sourceUrls,
      source_platforms: sourcePlatforms,
      raw_text: rawTextParts.join("\n\n") || undefined,
    };

    const supabase = createServerClient();
    const ingTotal =
      dbPayload.ingredients.core.length + dbPayload.ingredients.optional.length;
    const needsUserInput = ingTotal === 0 && dbPayload.steps.length === 0;
    const { data, error } = await supabase
      .from("recipes")
      .insert({
        user_id: recipeRow.user_id,
        title: recipeRow.title,
        description: recipeRow.description,
        ingredients: recipeRow.ingredients,
        steps: recipeRow.steps,
        tips: recipeRow.tips,
        estimated_time: recipeRow.estimated_time,
        servings: recipeRow.servings,
        servings_base: recipeRow.servings_base,
        source_urls: recipeRow.source_urls,
        source_platforms: recipeRow.source_platforms,
        raw_text: recipeRow.raw_text,
        needs_user_input: needsUserInput,
        updated_at: new Date().toISOString(),
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
