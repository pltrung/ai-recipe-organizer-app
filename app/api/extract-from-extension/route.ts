import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { detectPlatform } from "@/lib/platformDetector";
import { extractRecipe } from "@/lib/aiExtractor";
import {
  mergeRecipesIntelligent,
  mergedOutputToDbRow,
} from "@/lib/aiMerge";
import { recipeFromDbRow } from "@/lib/parseRecipeFromDb";
import type { ExtractedRecipeWithConfidence } from "@/lib/types";
import { EXTENSION_CORS_HEADERS } from "@/lib/extensionCors";

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

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
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

function rowToMergeSource(
  row: Record<string, unknown>
): ExtractedRecipeWithConfidence {
  const r = recipeFromDbRow(row);
  const flat = [...r.ingredients.core, ...r.ingredients.optional];
  const legacy = asStringArray(row.ingredients);
  return {
    title: r.title || "Recipe",
    description: r.description,
    ingredients:
      flat.length > 0
        ? flat
        : legacy.map((s) => ({
            quantity: null as number | null,
            unit: "",
            name: s,
            original: s,
          })),
    steps: asStringArray(row.steps),
    estimated_time: r.estimated_time || "—",
    servings: r.servings,
    servings_base: r.servings_base,
    confidence: "high",
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

    const openaiKey = process.env.OPENAI_API_KEY;
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

      const prevUrls = asStringArray(row.source_urls);
      const prevPlats = asStringArray(row.source_platforms);
      const { urls: source_urls, plats: source_platforms } = mergeSources(
        prevUrls,
        prevPlats,
        sourceUrl,
        plat
      );

      const separator = row.raw_text
        ? `\n\n---\n${sourceUrl || "source"}\n---\n\n`
        : "";
      const rawCombined = `${row.raw_text ?? ""}${separator}${rawText}`.slice(
        0,
        500_000
      );

      /** Existing row + new page → mergeRecipesIntelligent (dedupe ingredients, rewrite steps, tips) */
      const existing = rowToMergeSource(row);
      let dbPayload = mergedOutputToDbRow(
        (await mergeRecipesIntelligent([existing], openaiKey || ""))!
      );

      if (!isWeak) {
        const newPart = await extractRecipe(rawText, openaiKey || "");
        const hasNew =
          newPart.ingredients.length > 0 || newPart.steps.length > 0;
        if (hasNew) {
          const newWithConf: ExtractedRecipeWithConfidence = {
            ...newPart,
            confidence: "medium",
          };
          const mergedOut = await mergeRecipesIntelligent(
            [existing, newWithConf],
            openaiKey || ""
          );
          if (mergedOut) dbPayload = mergedOutputToDbRow(mergedOut);
        }
      }

      const ingTotal =
        dbPayload.ingredients.core.length +
        dbPayload.ingredients.optional.length;
      const needs_user_input =
        ingTotal === 0 && dbPayload.steps.length === 0;

      const preserved = recipeFromDbRow(row as Record<string, unknown>);

      const { error: upErr } = await supabase
        .from("recipes")
        .update({
          title: dbPayload.title,
          description: dbPayload.description,
          ingredients: dbPayload.ingredients,
          steps: dbPayload.steps,
          tips: dbPayload.tips,
          estimated_time: dbPayload.estimated_time,
          servings: preserved.servings || dbPayload.servings,
          servings_base: preserved.servings_base,
          source_urls,
          source_platforms,
          raw_text: rawCombined || null,
          needs_user_input,
          updated_at: new Date().toISOString(),
        })
        .eq("id", recipeId);

      if (upErr) {
        console.error("extract-from-extension update:", upErr);
        return json({ error: "Failed to update recipe" }, { status: 500 });
      }

      return json({
        recipeId,
        title: dbPayload.title,
        sourceCount: Math.max(source_urls.length, 1),
        merged: true,
      });
    }

    let extracted: import("@/lib/types").ExtractedRecipe;
    if (isWeak || !openaiKey) {
      extracted = {
        title: "Draft Recipe",
        description: "",
        ingredients: [],
        steps: [],
        estimated_time: "—",
        servings: "1 serving",
        servings_base: 1,
      };
    } else {
      extracted = await extractRecipe(rawText, openaiKey);
    }

    const title = recipeNameOpt
      ? recipeNameOpt
      : isWeak
        ? "Draft Recipe"
        : extracted.title;

    const needs_user_input =
      isWeak ||
      (extracted.ingredients.length === 0 && extracted.steps.length === 0);

    const source_urls = sourceUrl ? [sourceUrl] : [];
    const source_platforms =
      source_urls.length > 0 ? [plat] : [platformFromClient || "website"];

    const { data, error } = await supabase
      .from("recipes")
      .insert({
        user_id: null,
        title,
        description: extracted.description,
        ingredients: {
          core: extracted.ingredients,
          optional: [],
        },
        steps: extracted.steps,
        tips: [] as string[],
        estimated_time: extracted.estimated_time,
        servings: extracted.servings,
        servings_base: extracted.servings_base,
        source_urls,
        source_platforms,
        raw_text: rawText || null,
        needs_user_input,
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error) {
      console.error("extract-from-extension insert:", error);
      return json({ error: "Failed to save recipe" }, { status: 500 });
    }

    return json({
      recipeId: data.id,
      title,
      sourceCount: Math.max(source_urls.length, 1),
      merged: false,
    });
  } catch (e) {
    console.error("extract-from-extension error:", e);
    return json({ error: "Server error" }, { status: 500 });
  }
}
