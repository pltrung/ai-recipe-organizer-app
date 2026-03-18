import type { ExtractedRecipeWithConfidence, StructuredIngredient } from "./types";
import { coerceStructuredIngredient, parseIngredientLine } from "./ingredientParser";

const CONF_ORDER = { high: 0, medium: 1, low: 2 };

/** Strip quantities/units for cross-source matching */
export function normalizeIngredientKey(line: string): string {
  let s = line.toLowerCase().replace(/\s+/g, " ").trim();
  s = s.replace(/^[\d.\s\/–\-]+/, "");
  s = s.replace(
    /\b\d+(\.\d+)?\s*(cup|cups|tbsp|tablespoons?|tsp|teaspoons?|oz|ounce|ounces|g|gram|grams|kg|ml|l|lb|lbs|pound|cloves?|stalks?|pieces?|tbsp|tbs)\b/gi,
    " "
  );
  s = s.replace(
    /\b(cup|cups|tbsp|tablespoons?|tsp|teaspoons?|ounce|ounces|oz|grams?|g\b|kg|ml|liter|lb|pound|clove|stalk|piece|large|medium|small|whole|optional|pinch|dash)\b/gi,
    " "
  );
  s = s.replace(/[^a-z0-9\s]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length < 2) {
    return line
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  }
  return s.slice(0, 100);
}

function keyForIngredient(i: StructuredIngredient): string {
  const label = (i.name || i.original || "").trim();
  return normalizeIngredientKey(label);
}

type Entry = {
  sources: Set<number>;
  ingredient: StructuredIngredient;
  confRank: number;
};

function pickBetterIngredient(
  a: StructuredIngredient,
  b: StructuredIngredient
): StructuredIngredient {
  const aQ = a.quantity != null ? 1 : 0;
  const bQ = b.quantity != null ? 1 : 0;
  if (bQ > aQ) return b;
  if (aQ > bQ) return a;
  if ((b.name?.length ?? 0) > (a.name?.length ?? 0)) return b;
  return a;
}

/**
 * Multi-source: ingredient in 2+ sources → core; single source → optional.
 * Deduplicates by normalized name; keeps structured format.
 */
export function groupIngredientsBySourceOverlap(
  sources: ExtractedRecipeWithConfidence[]
): { core: StructuredIngredient[]; optional: StructuredIngredient[] } {
  const normalizedSources = sources.map((s) => ({
    ...s,
    ingredients: s.ingredients.map((x) =>
      typeof x === "string" ? parseIngredientLine(x) : coerceStructuredIngredient(x)
    ),
  }));

  if (normalizedSources.length <= 1) {
    const ing = normalizedSources[0]?.ingredients ?? [];
    const uniq: StructuredIngredient[] = [];
    const seen = new Set<string>();
    for (const x of ing) {
      const k = keyForIngredient(x);
      if (!k && !x.original && x.quantity == null) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      uniq.push(x);
    }
    return { core: uniq, optional: [] };
  }

  const byKey = new Map<string, Entry>();

  normalizedSources.forEach((rec, srcIdx) => {
    const rank = CONF_ORDER[rec.confidence] ?? 2;
    const seenKeys = new Set<string>();
    for (const ing of rec.ingredients) {
      const k = keyForIngredient(ing);
      if (!k && !ing.original?.trim() && ing.quantity == null) continue;
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);

      const prev = byKey.get(k);
      if (!prev) {
        byKey.set(k, {
          sources: new Set([srcIdx]),
          ingredient: ing,
          confRank: rank,
        });
      } else {
        prev.sources.add(srcIdx);
        if (rank < prev.confRank) {
          prev.ingredient = ing;
          prev.confRank = rank;
        } else if (rank === prev.confRank) {
          prev.ingredient = pickBetterIngredient(prev.ingredient, ing);
        }
      }
    }
  });

  const core: StructuredIngredient[] = [];
  const optional: StructuredIngredient[] = [];
  const entries = Array.from(byKey.entries()).sort((a, b) =>
    (a[1].ingredient.name || a[1].ingredient.original).localeCompare(
      b[1].ingredient.name || b[1].ingredient.original
    )
  );

  for (const [, v] of entries) {
    if (v.sources.size >= 2) core.push(v.ingredient);
    else optional.push(v.ingredient);
  }

  return { core, optional };
}

/** Format structured ingredient for display (original line preferred). */
function ingredientDisplayLine(i: StructuredIngredient): string {
  return (i.original || i.name || "").trim() || "";
}

/**
 * Build a deduplicated, cleaned list of ingredient lines for the chef AI pass.
 * Dedupes by normalized name, trims noise, caps size.
 */
export function buildCleanedIngredientLinesForChef(
  sources: ExtractedRecipeWithConfidence[],
  maxLines = 50
): string[] {
  const { core, optional } = groupIngredientsBySourceOverlap(sources);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const i of [...core, ...optional]) {
    const line = ingredientDisplayLine(i);
    if (!line) continue;
    const k = normalizeIngredientKey(line);
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(line.trim());
    if (lines.length >= maxLines) break;
  }
  return lines;
}
