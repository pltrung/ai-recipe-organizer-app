import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { detectPlatform } from "@/lib/platformDetector";
import { extractRecipe } from "@/lib/aiExtractor";
import {
  mergedOutputToDbRow,
  synthesisPayloadToMerged,
} from "@/lib/aiMerge";
import { recipeFromDbRow } from "@/lib/parseRecipeFromDb";
import {
  finalizeStructuredSteps,
  fallbackStructuredSteps,
} from "@/lib/structuredSteps";
import { EXTENSION_CORS_HEADERS } from "@/lib/extensionCors";
import { synthesizeRecipeFromCombinedRaw } from "@/lib/recipeSynthesis";
import {
  hydrateRecipeSourceHistory,
  RAW_TEXT_JOINER,
  asStringArray,
} from "@/lib/recipeSourceHistory";
import { diffRecipes } from "@/lib/recipeDiff";
import {
  summarizeRecipeDiffWithAi,
  heuristicDiffSummary,
} from "@/lib/recipeDiffAi";
import type { Recipe } from "@/lib/types";

const WEAK_RAW_LEN = 200;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: EXTENSION_CORS_HEADERS });
}

function json(data: object, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...EXTENSION_CORS_HEADERS, ...(init?.headers as object) },
  });
}

function mergeSources(
  prevUrls: string[],
  prevPlats: string[],
  url: string,
  p: string
) {
  const urls = [...prevUrls];
  const plats = [...prevPlats];
  if (url && !urls.includes(url)) {
    urls.push(url);
    plats.push(p);
  }
  while (plats.length < urls.length) plats.push("website");
  return { urls, plats };
}

function fullRecipeFromRow(row: Record<string, unknown>) {
  const r = recipeFromDbRow(row);
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    ingredients: r.ingredients,
    steps: r.steps,
    tips: r.tips,
    substitutions: r.substitutions,
    mistakes: r.mistakes,
    techniques: r.techniques,
    estimated_time: r.estimated_time,
    servings: r.servings,
    servings_base: r.servings_base,
    source_urls: r.source_urls,
    source_platforms: r.source_platforms,
    sources: r.sources ?? [],
    raw_texts: r.raw_texts ?? [],
    needs_user_input: Boolean(r.needs_user_input),
    needs_review: Boolean(r.needs_review),
    updated_at: row.updated_at ?? null,
    last_diff: r.last_diff ?? null,
    versions: r.versions ?? [],
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      raw_text?: string;
      source_url?: string;
      platform?: string;
      recipeId?: string | null;
      recipe_name?: string;
    };
    const rawText =
      typeof body?.raw_text === "string" ? body.raw_text.trim() : "";
    const sourceUrl =
      typeof body?.source_url === "string" ? body.source_url.trim() : "";
    const platformFromClient =
      typeof body?.platform === "string" ? body.platform.trim() : "";
    const recipeId =
      typeof body?.recipeId === "string" && body.recipeId.trim()
        ? body.recipeId.trim()
        : null;
    const recipeNameOpt =
      typeof body?.recipe_name === "string" ? body.recipe_name.trim() : "";

    const openaiKey = process.env.OPENAI_API_KEY?.trim() || "";
    const supabase = createServerClient();

    const isWeak = rawText.length < WEAK_RAW_LEN;
    const plat = sourceUrl
      ? detectPlatform(sourceUrl)
      : platformFromClient || "website";

    if (recipeId) {
      const { data: row, error: fetchErr } = await supabase
        .from("recipes")
        .select("*")
        .eq("id", recipeId)
        .single();

      if (fetchErr || !row) {
        return json({ error: "Recipe not found" }, { status: 404 });
      }

      const rec = row as Record<string, unknown>;
      const prevUrls = asStringArray(rec.source_urls);
      const prevPlats = asStringArray(rec.source_platforms);
      const { urls: source_urls, plats: source_platforms } = mergeSources(
        prevUrls,
        prevPlats,
        sourceUrl,
        plat
      );

      const { sources: srcHist, raw_texts: rawHist } =
        hydrateRecipeSourceHistory(rec);
      const sourcesBefore = rawHist.length;
      const newSourceLabel = sourceUrl || plat || "unknown";
      const nextSources = [...srcHist, newSourceLabel];
      const nextRawTexts = [...rawHist, rawText];
      const sourcesAfter = nextRawTexts.length;
      const combinedText = nextRawTexts.join(RAW_TEXT_JOINER).slice(0, 500_000);

      console.log(
        `[extract-from-extension] merge recipeId=${recipeId} sourcesBefore=${sourcesBefore} sourcesAfter=${sourcesAfter} combinedLen=${combinedText.length}`
      );

      const fallbackTitle =
        typeof rec.title === "string" && String(rec.title).trim()
          ? String(rec.title).trim()
          : "Recipe";

      let synthOk = false;
      let dbPayload: ReturnType<typeof mergedOutputToDbRow> | null = null;

      if (openaiKey && combinedText.trim().length > 0) {
        try {
          const synth = await synthesizeRecipeFromCombinedRaw(
            combinedText,
            openaiKey,
            fallbackTitle
          );
          if (synth) {
            const merged = synthesisPayloadToMerged(synth);
            dbPayload = mergedOutputToDbRow(merged);
            const ingTotal =
              dbPayload.ingredients.core.length +
              dbPayload.ingredients.optional.length;
            if (ingTotal > 0 || dbPayload.steps.length > 0) {
              synthOk = true;
            }
          }
        } catch (e) {
          console.error("[extract-from-extension] synthesis threw:", e);
        }
      }

      if (synthOk && dbPayload) {
        const ingTotal =
          dbPayload.ingredients.core.length +
          dbPayload.ingredients.optional.length;
        const needs_user_input =
          ingTotal === 0 && dbPayload.steps.length === 0;

        console.log(
          `[extract-from-extension] AI ok title=${dbPayload.title.slice(0, 60)} coreIngs=${dbPayload.ingredients.core.length} steps=${dbPayload.steps.length} tips=${dbPayload.tips.length}`
        );

        const previousRecipe = recipeFromDbRow(rec);
        const nextRecipe: Recipe = {
          ...previousRecipe,
          title: dbPayload.title,
          description: dbPayload.description,
          ingredients: dbPayload.ingredients,
          steps: dbPayload.steps,
          tips: dbPayload.tips,
          substitutions: dbPayload.substitutions as Recipe["substitutions"],
          mistakes: dbPayload.mistakes,
          techniques: dbPayload.techniques,
          estimated_time: dbPayload.estimated_time,
          servings: dbPayload.servings,
          servings_base: dbPayload.servings_base,
        };
        const structured = diffRecipes(previousRecipe, nextRecipe);
        const aiPart =
          (await summarizeRecipeDiffWithAi(
            previousRecipe,
            nextRecipe,
            structured,
            openaiKey
          )) ?? heuristicDiffSummary(structured);
        let key_improvements = [...aiPart.key_improvements];
        if (key_improvements.length < 2) {
          const h = heuristicDiffSummary(structured).key_improvements;
          const seen = new Set(key_improvements.map((x) => x.slice(0, 50)));
          for (const line of h) {
            if (key_improvements.length >= 8) break;
            if (!seen.has(line.slice(0, 50))) {
              seen.add(line.slice(0, 50));
              key_improvements.push(line);
            }
          }
        }
        const at = new Date().toISOString();
        const last_diff = {
          at,
          source_count_after: sourcesAfter,
          structured,
          summary: aiPart.summary,
          key_improvements: key_improvements.slice(0, 12),
        };
        const prevVer = Array.isArray(rec.versions) ? rec.versions : [];
        const versionEntry = {
          at,
          source_count_after: sourcesAfter,
          summary: last_diff.summary,
          key_improvements: last_diff.key_improvements.slice(0, 8),
        };
        const versions = [versionEntry, ...prevVer].slice(0, 10);

        const { error: upErr } = await supabase
          .from("recipes")
          .update({
            title: dbPayload.title,
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
            source_urls,
            source_platforms,
            sources: nextSources,
            raw_texts: nextRawTexts,
            raw_text: combinedText || null,
            needs_user_input,
            needs_review: false,
            last_diff,
            versions,
            updated_at: at,
          })
          .eq("id", recipeId);

        if (upErr) {
          console.error("extract-from-extension update:", upErr);
          return json({ error: "Failed to update recipe" }, { status: 500 });
        }

        const { data: fresh } = await supabase
          .from("recipes")
          .select("*")
          .eq("id", recipeId)
          .single();

        return json({
          recipeId,
          title: dbPayload.title,
          sourceCount: sourcesAfter,
          merged: true,
          synthesisFailed: false,
          last_diff,
          recipe: fresh ? fullRecipeFromRow(fresh as Record<string, unknown>) : null,
        });
      }

      console.warn(
        `[extract-from-extension] AI failed or skipped; appending source only, needs_review=true`
      );

      const { error: upErr } = await supabase
        .from("recipes")
        .update({
          source_urls,
          source_platforms,
          sources: nextSources,
          raw_texts: nextRawTexts,
          raw_text: combinedText || null,
          needs_review: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", recipeId);

      if (upErr) {
        console.error("extract-from-extension partial update:", upErr);
        return json({ error: "Failed to update recipe" }, { status: 500 });
      }

      const { data: fresh } = await supabase
        .from("recipes")
        .select("*")
        .eq("id", recipeId)
        .single();

      return json({
        recipeId,
        title: fallbackTitle,
        sourceCount: sourcesAfter,
        merged: true,
        synthesisFailed: true,
        recipe: fresh ? fullRecipeFromRow(fresh as Record<string, unknown>) : null,
      });
    }

    /* New recipe */
    const sources = [sourceUrl || plat || "website"];
    const raw_texts = [rawText];
    const source_urls = sourceUrl ? [sourceUrl] : [];
    const source_platforms =
      source_urls.length > 0 ? [plat] : [platformFromClient || "website"];

    let insertRow: Record<string, unknown>;

    if (isWeak || !openaiKey) {
      const title = recipeNameOpt || "Draft Recipe";
      insertRow = {
        user_id: null,
        title,
        description: "",
        ingredients: { core: [], optional: [] },
        steps: [] as object[],
        tips: [] as string[],
        substitutions: [] as string[],
        mistakes: [] as string[],
        techniques: [] as string[],
        estimated_time: "—",
        servings: "1 serving",
        servings_base: 1,
        source_urls,
        source_platforms,
        sources,
        raw_texts,
        raw_text: rawText || null,
        needs_user_input: true,
        needs_review: false,
        updated_at: new Date().toISOString(),
      };
    } else {
      const synthNew = await synthesizeRecipeFromCombinedRaw(
        rawText,
        openaiKey,
        recipeNameOpt || "Recipe"
      );
      if (synthNew) {
        const dbPayload = mergedOutputToDbRow(synthesisPayloadToMerged(synthNew));
        const ingTotal =
          dbPayload.ingredients.core.length + dbPayload.ingredients.optional.length;
        const needs = ingTotal === 0 && dbPayload.steps.length === 0;
        insertRow = {
          user_id: null,
          title: recipeNameOpt || dbPayload.title,
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
          source_urls,
          source_platforms,
          sources,
          raw_texts,
          raw_text: rawText || null,
          needs_user_input: needs,
          needs_review: false,
          updated_at: new Date().toISOString(),
        };
      } else {
        const extracted = await extractRecipe(rawText, openaiKey);
        const title = recipeNameOpt || extracted.title;
        const structuredSteps =
          extracted.steps.length > 0
            ? (await finalizeStructuredSteps(extracted.steps, openaiKey)) ??
              fallbackStructuredSteps(extracted.steps)
            : [];
        const needs_user_input =
          extracted.ingredients.length === 0 && extracted.steps.length === 0;
        insertRow = {
          user_id: null,
          title,
          description: extracted.description,
          ingredients: { core: extracted.ingredients, optional: [] },
          steps: structuredSteps,
          tips: [] as string[],
          substitutions: [] as string[],
          mistakes: [] as string[],
          techniques: [] as string[],
          estimated_time: extracted.estimated_time,
          servings: extracted.servings,
          servings_base: extracted.servings_base,
          source_urls,
          source_platforms,
          sources,
          raw_texts,
          raw_text: rawText || null,
          needs_user_input,
          needs_review: true,
          updated_at: new Date().toISOString(),
        };
      }
    }

    const { data, error } = await supabase
      .from("recipes")
      .insert(insertRow)
      .select("*")
      .single();

    if (error) {
      console.error("extract-from-extension insert:", error);
      return json({ error: "Failed to save recipe" }, { status: 500 });
    }

    const row = data as Record<string, unknown>;
    const r = recipeFromDbRow(row);

    return json({
      recipeId: String(row.id),
      title: r.title,
      sourceCount: Math.max(source_urls.length, 1),
      merged: false,
      synthesisFailed: Boolean(row.needs_review),
      recipe: fullRecipeFromRow(row),
    });
  } catch (e) {
    console.error("extract-from-extension error:", e);
    return json({ error: "Server error" }, { status: 500 });
  }
}
