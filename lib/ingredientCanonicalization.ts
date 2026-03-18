/**
 * Phase A → canonical ingredient entities → scoring (single dedupe point).
 */

import type { SourceConfidence } from "./sourceSynthesisConfidence";
import { coerceStructuredIngredient } from "./ingredientParser";
import { normalizeIngredientName } from "./ingredientNormalize";

export type CanonicalIngredientEntity = {
  canonical_name: string;
  variants: {
    line: string;
    sourceIndex: number;
    sourceConf: SourceConfidence;
  }[];
  ingredient_type: string;
};

export type NumberedIngredientLine = {
  line: string;
  sourceIndex: number;
  sourceConf: SourceConfidence;
};

function stemFromLine(line: string): string {
  const t = line.trim();
  if (!t) return "";
  const stripped = t.replace(
    /^[\d./\s-]+(?:\d+\/\d+)?\s*(?:tbsp|tsp|tablespoons?|teaspoons?|cups?|oz|lb|lbs|g|kg|ml|l|cloves?|pieces?|large|medium|small)?\.?\s*/i,
    ""
  );
  const blob = (stripped || t).slice(0, 100);
  return normalizeIngredientName(blob) || cleaningKey(blob);
}

function cleaningKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s\u00C0-\u024F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function clusterKeyForLine(line: string): string {
  const ing = coerceStructuredIngredient(line);
  const n = normalizeIngredientName(ing.name || ing.original || "");
  if (n.length >= 2) return n.toLowerCase();
  const stem = stemFromLine(line);
  return stem ? stem.toLowerCase() : cleaningKey(line);
}

function inferIngredientType(canonicalName: string): string {
  const n = canonicalName.toLowerCase();
  if (/\b(chicken|beef|pork|fish|shrimp|tofu|turkey|lamb)\b/.test(n))
    return "protein";
  if (/\b(egg|eggs|yolk|yolks)\b/.test(n)) return "protein";
  if (/\b(cream|milk|mascarpone|butter|cheese|yogurt|ricotta)\b/.test(n))
    return "dairy";
  if (/\b(flour|starch|cornstarch|noodle|pasta|rice|bread|ladyfinger)\b/.test(n))
    return "starch";
  if (/\b(oil|broth|stock|water|wine|coffee|espresso|juice|liqueur|rum|marsala|kahlua)\b/.test(
    n
  ))
    return "liquid";
  if (/\b(sugar|salt|honey|syrup)\b/.test(n)) return "sweetener";
  if (/\b(vanilla|cinnamon|spice|herb|garlic|cocoa|chocolate|extract)\b/.test(n))
    return "flavor";
  return "other";
}

/**
 * Collapse Phase A lines into one entity per canonical ingredient identity.
 */
export function canonicalizeIngredients(
  numbered: NumberedIngredientLine[]
): CanonicalIngredientEntity[] {
  const raw = numbered.length;
  const byKey = new Map<string, CanonicalIngredientEntity>();

  for (const row of numbered) {
    const key = clusterKeyForLine(row.line);
    if (!key || key.length < 2) continue;

    let e = byKey.get(key);
    if (!e) {
      const ing = coerceStructuredIngredient(row.line);
      const display =
        normalizeIngredientName(ing.name || ing.original || row.line) ||
        stemFromLine(row.line) ||
        key;
      e = {
        canonical_name: display,
        variants: [],
        ingredient_type: inferIngredientType(display),
      };
      byKey.set(key, e);
    }
    e.variants.push({
      line: row.line,
      sourceIndex: row.sourceIndex,
      sourceConf: row.sourceConf,
    });
  }

  const entities = Array.from(byKey.values());
  for (const e of entities) {
    const best = e.variants[0]!;
    const ing = coerceStructuredIngredient(best.line);
    e.canonical_name =
      normalizeIngredientName(ing.name || ing.original || best.line) ||
      e.canonical_name;
    e.ingredient_type = inferIngredientType(e.canonical_name);
  }
  const canonical = entities.length;
  console.log(
    `[ingredient-canonicalization] raw_count=${raw} canonical_count=${canonical} clusters_formed=${canonical}`
  );
  return entities;
}
