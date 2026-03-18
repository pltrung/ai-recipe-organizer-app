import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { classifyLink } from "@/lib/classifyLink";
import { detectPlatform } from "@/lib/platformDetector";
import { ingestUrl, ingestImage } from "@/lib/sourcePipeline";
import {
  mergeRecipesIntelligent,
  mergedOutputToDbRow,
  synthesisPayloadToMerged,
} from "@/lib/aiMerge";
import { synthesizeRecipeFromCombinedRawWithExtractions } from "@/lib/recipeSynthesis";
import { RAW_TEXT_JOINER } from "@/lib/recipeSourceHistory";
import type { ExtractedRecipe } from "@/lib/types";
import { parseIngredientLine } from "@/lib/ingredientParser";
import {
  finalizeStructuredSteps,
  fallbackStructuredSteps,
} from "@/lib/structuredSteps";

function recipeToFallbackRaw(r: ExtractedRecipe): string {
  const ing = r.ingredients
    .map((i) =>
      i.original ||
      [i.quantity, i.unit, i.name].filter(Boolean).join(" ")
    )
    .filter(Boolean)
    .join("\n");
  const st = r.steps.map((s, j) => `${j + 1}. ${s}`).join("\n");
  return [r.title, r.description, ing, st].filter(Boolean).join("\n\n");
}

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
      const stepLines = fallback.steps.map((s) => String(s).trim()).filter(Boolean);
      const structuredSteps =
        stepLines.length > 0
          ? (await finalizeStructuredSteps(
              stepLines,
              process.env.OPENAI_API_KEY || ""
            )) ?? fallbackStructuredSteps(stepLines)
          : [];
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
          substitutions: [] as object[],
          mistakes: [] as string[],
          techniques: [] as string[],
          steps: structuredSteps,
          estimated_time: "—",
          servings: "1 serving",
          servings_base: 1,
          source_urls: validUrls,
          source_platforms: validUrls.map((u: string) => detectPlatform(u)),
          raw_text: null,
          sources: validUrls.length ? validUrls : ["manual"],
          raw_texts: validUrls.length
            ? validUrls.map(() => "")
            : [""],
          needs_review: false,
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
    const historySources: string[] = [];
    const historyRawTexts: string[] = [];
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
        if (outcome.recipe) {
          successfulRecipes.push(outcome.recipe);
          const raw =
            outcome.rawForDb?.trim() ||
            recipeToFallbackRaw(outcome.recipe) ||
            u;
          historySources.push(u);
          historyRawTexts.push(raw);
          rawTextParts.push(`--- ${u} ---\n${raw}`);
        } else if (outcome.rawForDb?.trim()) {
          const raw = outcome.rawForDb.trim();
          historySources.push(u);
          historyRawTexts.push(raw);
          rawTextParts.push(`--- ${u} ---\n${raw}`);
        }
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
        const label = `image:${i + 1}`;
        if (outcome.recipe) {
          successfulRecipes.push(outcome.recipe);
          const raw =
            outcome.rawForDb?.trim() ||
            recipeToFallbackRaw(outcome.recipe) ||
            label;
          historySources.push(label);
          historyRawTexts.push(raw);
          rawTextParts.push(`--- ${label} ---\n${raw}`);
        } else if (outcome.rawForDb?.trim()) {
          const raw = outcome.rawForDb.trim();
          historySources.push(label);
          historyRawTexts.push(raw);
          rawTextParts.push(`--- ${label} ---\n${raw}`);
        }
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

    const combinedText = historyRawTexts.join(RAW_TEXT_JOINER);

    if (successfulRecipes.length === 0) {
      if (historyRawTexts.length > 0) {
        const phasedOnly = await synthesizeRecipeFromCombinedRawWithExtractions(
          combinedText,
          openaiKey,
          dishName || "Recipe",
          { sources: historySources, raw_texts: historyRawTexts }
        );
        const synthOnly = phasedOnly?.payload;
        if (synthOnly) {
          const dbPayload = mergedOutputToDbRow(
            synthesisPayloadToMerged(synthOnly)
          );
          const ingTotal =
            dbPayload.ingredients.core.length +
            dbPayload.ingredients.optional.length;
          if (ingTotal > 0 || dbPayload.steps.length > 0) {
            const supabase = createServerClient();
            const title =
              dishName && dishName.length > 0 ? dishName : dbPayload.title;
            const srcEx =
              phasedOnly?.source_extractions?.map((ex, i) => ({
                source_url: historySources[i] ?? ex.source_label,
                source_type:
                  detectPlatform(String(historySources[i] || "")) ||
                  sourcePlatforms[i] ||
                  "website",
                raw_text: String(historyRawTexts[i] ?? "").slice(0, 8000),
                ingredient_candidates: ex.ingredient_candidates,
                step_candidates: ex.step_candidates,
                tip_candidates: ex.tip_candidates,
              })) ?? null;
            const { data, error } = await supabase
              .from("recipes")
              .insert({
                user_id: body.user_id ?? null,
                title,
                description: dbPayload.description,
                ingredients: dbPayload.ingredients,
                steps: dbPayload.steps,
                tips: dbPayload.tips,
                substitutions: dbPayload.substitutions,
                mistakes: dbPayload.mistakes,
                techniques: dbPayload.techniques,
                estimated_time: dbPayload.estimated_time,
                servings: dbPayload.servings,
                servings_base: dbPayload.servings_base,
                source_urls: sourceUrls,
                source_platforms: sourcePlatforms,
                raw_text: rawTextParts.join("\n\n") || null,
                sources: historySources,
                raw_texts: historyRawTexts,
                source_extractions: srcEx,
                needs_review: false,
                needs_user_input: false,
                updated_at: new Date().toISOString(),
              })
              .select("id")
              .single();
            if (!error && data) {
              console.log(
                `[recipes/create] raw-only corpus ok steps=${dbPayload.steps.length}`
              );
              return NextResponse.json({
                id: data.id,
                from_reel: hasReelInput,
                sources: sourceReports,
                extracted_count: extractedCount,
                total_count: totalCount,
              });
            }
          }
        }
      }

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
          substitutions: [] as object[],
          mistakes: [] as string[],
          techniques: [] as string[],
          steps: [],
          estimated_time: "—",
          servings: "1 serving",
          servings_base: 1,
          source_urls: sourceUrls,
          source_platforms: sourcePlatforms,
          raw_text: rawTextParts.join("\n\n") || null,
          sources:
            historySources.length > 0
              ? historySources
              : sourceUrls.length
                ? sourceUrls
                : ["draft"],
          raw_texts:
            historyRawTexts.length > 0
              ? historyRawTexts
              : rawTextParts.length
                ? rawTextParts
                : [],
          needs_review: historyRawTexts.length > 0 && successfulRecipes.length === 0,
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

    const sourcesBefore = historyRawTexts.length;
    console.log(
      `[recipes/create] corpus sources=${sourcesBefore} combinedLen=${combinedText.length}`
    );

    let dbPayload: ReturnType<typeof mergedOutputToDbRow>;
    let needsReview = false;

    const phasedMain = await synthesizeRecipeFromCombinedRawWithExtractions(
      combinedText,
      openaiKey,
      dishName || successfulRecipes[0]?.title || "Recipe",
      { sources: historySources, raw_texts: historyRawTexts }
    );
    const synth = phasedMain?.payload;
    let source_extractions: unknown =
      phasedMain?.source_extractions?.map((ex, i) => ({
        source_url: historySources[i] ?? ex.source_label,
        source_type:
          detectPlatform(String(historySources[i] || "")) ||
          sourcePlatforms[i] ||
          "website",
        raw_text: String(historyRawTexts[i] ?? "").slice(0, 8000),
        ingredient_candidates: ex.ingredient_candidates,
        step_candidates: ex.step_candidates,
        tip_candidates: ex.tip_candidates,
      })) ?? null;

    if (synth) {
      const merged = synthesisPayloadToMerged(synth);
      dbPayload = mergedOutputToDbRow(merged);
      const ingN =
        dbPayload.ingredients.core.length + dbPayload.ingredients.optional.length;
      if (ingN === 0 && dbPayload.steps.length === 0) {
        needsReview = true;
        source_extractions = null;
        let mergedOut =
          (await mergeRecipesIntelligent(successfulRecipes, openaiKey)) ??
          null;
        if (!mergedOut) {
          mergedOut = await mergeRecipesIntelligent(
            [successfulRecipes[0]],
            openaiKey
          );
        }
        if (mergedOut) dbPayload = mergedOutputToDbRow(mergedOut);
      } else {
        console.log(
          `[recipes/create] AI corpus ok title=${dbPayload.title.slice(0, 50)} steps=${dbPayload.steps.length}`
        );
      }
    } else {
      needsReview = true;
      source_extractions = null;
      let mergedOut =
        (await mergeRecipesIntelligent(successfulRecipes, openaiKey)) ?? null;
      if (!mergedOut) {
        mergedOut = await mergeRecipesIntelligent(
          [successfulRecipes[0]],
          openaiKey
        );
      }
      dbPayload = mergedOutputToDbRow(mergedOut!);
    }

    const title =
      dishName && dishName.length > 0 ? dishName : dbPayload.title;
    const recipeRow = {
      user_id: body.user_id ?? null,
      title,
      description: dbPayload.description,
      ingredients: dbPayload.ingredients,
      steps: dbPayload.steps,
      tips: dbPayload.tips,
      substitutions: dbPayload.substitutions,
      mistakes: dbPayload.mistakes,
      techniques: dbPayload.techniques,
      estimated_time: dbPayload.estimated_time,
      servings: dbPayload.servings,
      servings_base: dbPayload.servings_base,
      source_urls: sourceUrls,
      source_platforms: sourcePlatforms,
      raw_text: rawTextParts.join("\n\n") || undefined,
      sources: historySources.length ? historySources : sourceUrls,
      raw_texts: historyRawTexts.length ? historyRawTexts : [],
      needs_review: needsReview,
      source_extractions,
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
        substitutions: recipeRow.substitutions,
        mistakes: recipeRow.mistakes,
        techniques: recipeRow.techniques,
        estimated_time: recipeRow.estimated_time,
        servings: recipeRow.servings,
        servings_base: recipeRow.servings_base,
        source_urls: recipeRow.source_urls,
        source_platforms: recipeRow.source_platforms,
        raw_text: recipeRow.raw_text,
        sources: recipeRow.sources,
        raw_texts: recipeRow.raw_texts,
        source_extractions: recipeRow.source_extractions,
        needs_review: recipeRow.needs_review,
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
