import type { Recipe, RecipeIngredientsGrouped } from "./types";
import { coerceStructuredIngredient } from "./ingredientParser";
import { parseServingsCount, servingsDisplayLabel } from "./ingredientScale";

function parseIngredientsFromDb(raw: unknown): RecipeIngredientsGrouped {
  const toStructured = (arr: unknown[]): RecipeIngredientsGrouped["core"] => {
    return arr
      .map((x) => coerceStructuredIngredient(x))
      .filter((i) => (i.original || i.name || i.quantity != null));
  };

  if (Array.isArray(raw)) {
    return { core: toStructured(raw), optional: [] };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const core = Array.isArray(o.core) ? toStructured(o.core) : [];
    const optional = Array.isArray(o.optional) ? toStructured(o.optional) : [];
    return { core, optional };
  }
  return { core: [], optional: [] };
}

export { parseIngredientsFromDb };

export function parseTipsFromDb(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

export function recipeFromDbRow(data: Record<string, unknown>): Recipe {
  const ing = parseIngredientsFromDb(data.ingredients);
  const sbRaw = data.servings_base;
  let servings_base = 1;
  if (typeof sbRaw === "number" && sbRaw > 0 && sbRaw < 500) {
    servings_base = Math.round(sbRaw);
  } else {
    const fromServings = parseServingsCount(data.servings);
    if (fromServings != null) servings_base = fromServings;
  }

  return {
    id: String(data.id ?? ""),
    title: String(data.title ?? ""),
    description: String(data.description ?? ""),
    ingredients: ing,
    steps: Array.isArray(data.steps)
      ? data.steps.map((x) => String(x).trim()).filter(Boolean)
      : [],
    tips: parseTipsFromDb(data.tips),
    estimated_time: String(data.estimated_time ?? ""),
    servings: String(data.servings ?? "").trim() || servingsDisplayLabel(servings_base),
    servings_base,
    source_urls: Array.isArray(data.source_urls)
      ? data.source_urls.map(String)
      : [],
    source_platforms: Array.isArray(data.source_platforms)
      ? data.source_platforms.map(String)
      : [],
    needs_user_input: Boolean(data.needs_user_input),
  };
}
