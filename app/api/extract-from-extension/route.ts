import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { detectPlatform } from "@/lib/platformDetector";
import { extractRecipe } from "@/lib/aiExtractor";
import { mergeRecipes } from "@/lib/aiMerge";
import type { ExtractedRecipe } from "@/lib/types";

const WEAK_RAW_LEN = 200;

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

function rowToExtracted(row: {
  title: string;
  description: string | null;
  ingredients: unknown;
  steps: unknown;
  estimated_time: string | null;
  servings: string | null;
}): ExtractedRecipe {
  return {
    title: row.title || "Recipe",
    description: String(row.description ?? ""),
    ingredients: asStringArray(row.ingredients),
    steps: asStringArray(row.steps),
    estimated_time: String(row.estimated_time ?? "").trim() || "—",
    servings: String(row.servings ?? "").trim() || "—",
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
        return NextResponse.json({ error: "Recipe not found" }, { status: 404 });
      }

      const prevUrls = asStringArray(row.source_urls);
      const prevPlats = asStringArray(row.source_platforms);
      const { urls: source_urls, plats: source_platforms } = mergeSources(
        prevUrls,
        prevPlats,
        sourceUrl,
        plat
      );

      const separator = row.raw_text ? `\n\n---\n${sourceUrl || "source"}\n---\n\n` : "";
      const rawCombined = `${row.raw_text ?? ""}${separator}${rawText}`.slice(
        0,
        500_000
      );

      const existing = rowToExtracted(row);
      let merged: ExtractedRecipe = existing;

      if (!isWeak && openaiKey) {
        const newPart = await extractRecipe(rawText, openaiKey);
        const hasNew =
          newPart &&
          (newPart.ingredients.length > 0 || newPart.steps.length > 0);
        if (hasNew && newPart) {
          const out = await mergeRecipes([existing, newPart], openaiKey);
          if (out) merged = out;
        }
      }

      const needs_user_input =
        merged.ingredients.length === 0 && merged.steps.length === 0;

      const { error: upErr } = await supabase
        .from("recipes")
        .update({
          title: merged.title,
          description: merged.description,
          ingredients: merged.ingredients,
          steps: merged.steps,
          estimated_time: merged.estimated_time,
          servings: merged.servings,
          source_urls,
          source_platforms,
          raw_text: rawCombined || null,
          needs_user_input,
          updated_at: new Date().toISOString(),
        })
        .eq("id", recipeId);

      if (upErr) {
        console.error("extract-from-extension update:", upErr);
        return NextResponse.json(
          { error: "Failed to update recipe" },
          { status: 500 }
        );
      }

      return NextResponse.json({
        recipeId,
        title: merged.title,
        sourceCount: Math.max(source_urls.length, 1),
        merged: true,
      });
    }

    // —— Create new recipe (always persist; draft if weak capture) ——
    let extracted: ExtractedRecipe;
    if (isWeak || !openaiKey) {
      extracted = {
        title: "Draft Recipe",
        description: "",
        ingredients: [],
        steps: [],
        estimated_time: "—",
        servings: "—",
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
        ingredients: extracted.ingredients,
        steps: extracted.steps,
        estimated_time: extracted.estimated_time,
        servings: extracted.servings,
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
      return NextResponse.json(
        { error: "Failed to save recipe" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      recipeId: data.id,
      title,
      sourceCount: Math.max(source_urls.length, 1),
      merged: false,
    });
  } catch (e) {
    console.error("extract-from-extension error:", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
