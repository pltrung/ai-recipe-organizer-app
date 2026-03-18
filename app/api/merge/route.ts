import { NextRequest, NextResponse } from "next/server";
import { mergeRecipes } from "@/lib/aiMerge";
import { coerceStructuredIngredient, parseIngredientLine } from "@/lib/ingredientParser";
import {
  parseServingsCount,
  servingsDisplayLabel,
} from "@/lib/ingredientScale";
import type { ExtractedRecipe } from "@/lib/types";

function normalizeIncomingRecipe(raw: Record<string, unknown>): ExtractedRecipe {
  const ingRaw = raw.ingredients;
  const ingredients = Array.isArray(ingRaw)
    ? ingRaw.map((x) =>
        typeof x === "string"
          ? parseIngredientLine(x)
          : coerceStructuredIngredient(x)
      )
    : [];
  const sb =
    typeof raw.servings_base === "number" && raw.servings_base > 0
      ? Math.round(raw.servings_base)
      : parseServingsCount(raw.servings) ?? 1;
  return {
    title: String(raw.title ?? ""),
    description: String(raw.description ?? ""),
    ingredients,
    steps: Array.isArray(raw.steps)
      ? raw.steps.map((s) => String(s).trim()).filter(Boolean)
      : [],
    estimated_time: String(raw.estimated_time ?? "—"),
    servings:
      String(raw.servings ?? "").trim() || servingsDisplayLabel(sb),
    servings_base: sb,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { recipes: unknown[] };
    if (!Array.isArray(body.recipes) || body.recipes.length === 0) {
      return NextResponse.json({ error: "Missing or empty recipes" }, { status: 400 });
    }
    const recipes = body.recipes.map((r) =>
      normalizeIncomingRecipe(
        r && typeof r === "object" ? (r as Record<string, unknown>) : {}
      )
    );
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return NextResponse.json({ error: "OpenAI not configured" }, { status: 500 });
    }
    const merged = await mergeRecipes(recipes, key);
    if (!merged) {
      return NextResponse.json({ error: "Merge failed" }, { status: 422 });
    }
    return NextResponse.json(merged);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
