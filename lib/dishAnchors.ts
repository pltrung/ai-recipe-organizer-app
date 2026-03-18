/**
 * Dish anchor slots — chef-level identity, not DOM noise.
 * Anchors drive mandatory CORE classification (overrides confidence).
 */

import type { StructuredIngredient } from "./types";
import { coerceStructuredIngredient } from "./ingredientParser";
import { normalizeIngredientName } from "./ingredientNormalize";

export const DISH_FAMILY_DEFAULT_ANCHORS: Record<string, string[]> = {
  noodle_soup: ["broth", "noodles", "protein"],
  braise_stew: ["protein", "cooking_liquid", "aromatic_base"],
  stir_fry: ["protein", "cooking_oil", "sauce_or_seasoning"],
  layered_chilled_dessert: ["cream_or_custard", "base_or_sponge"],
  baked_cake: ["structure_flour", "fat", "sweetener", "egg_or_leavener"],
  pizza_flatbread: ["dough", "sauce", "cheese"],
  pasta: ["pasta", "sauce"],
  salad_no_cook: ["greens_or_base", "dressing"],
  sauce_condiment: ["base", "balance_acid_salt"],
  rice_plate: ["rice", "protein_or_main"],
  wrap_roll: ["wrapper", "filling"],
  other: [],
};

/** Name-based anchors for dishes that map to family "other" but need structure. */
export function inferAnchorsFromDishName(dishName: string): string[] {
  const n = dishName.toLowerCase();
  if (
    /karaage|fried chicken|chicken fried|katsu|tempura|breaded|tonkatsu|schnitzel|fish and chips/i.test(
      n
    )
  ) {
    return ["protein", "coating_starch", "frying_oil", "marinade_base"];
  }
  if (/ramen|pho|noodle soup|laksa|udon soup/i.test(n)) {
    return ["broth", "noodles", "protein"];
  }
  if (/pizza|flatbread|focaccia/i.test(n)) {
    return ["dough", "sauce", "cheese"];
  }
  if (/stir.fry|stir fry|chow mein/i.test(n)) {
    return ["protein", "cooking_oil", "sauce_or_seasoning"];
  }
  return [];
}

export function mergeDishAnchors(
  family: string,
  fromPlaybook: string[],
  dishName: string
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [
    ...inferAnchorsFromDishName(dishName),
    ...(DISH_FAMILY_DEFAULT_ANCHORS[family] ?? []),
    ...fromPlaybook,
  ]) {
    const k = x.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x.trim());
  }
  return out.slice(0, 12);
}

export type MaterializedAnchor = { slot: string; line: string };

/** Pick best candidate line per anchor slot from raw Phase A lines. */
export function materializeAnchorsFromLines(
  anchors: string[],
  lines: string[]
): MaterializedAnchor[] {
  const out: MaterializedAnchor[] = [];
  const used = new Set<string>();

  for (const raw of anchors) {
    const a = raw.toLowerCase().replace(/\s+/g, "_");
    let hit: string | undefined;

    if (/^protein|main_meat/.test(a) || a === "protein") {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /\b(chicken|beef|pork|lamb|turkey|duck|fish|salmon|cod|tuna|shrimp|prawn|scallop|tofu|tempeh|egg\s*plant|eggplant)\b/i.test(
            l
          )
      );
    } else if (/coating|starch|batter|bread/i.test(a)) {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /cornstarch|corn starch|potato starch|flour|all.purpose|panko|breadcrum|tempura|rice flour/i.test(
            l
          )
      );
    } else if (/frying_oil|cooking_oil|fry/.test(a) && /oil|fat/.test(a)) {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /\b(oil|lard|shortening|ghee)\b/i.test(l) &&
          /cup|tbsp|tsp|ml|l\b|quart|liter|litre|for frying|deep/i.test(l)
      );
      if (!hit) {
        hit = lines.find(
          (l) =>
            !used.has(l) &&
            /(vegetable|neutral|canola|peanut|sunflower|grapeseed).*oil/i.test(l)
        );
      }
    } else if (/marinade|soy|umami|flavor_base|sauce_or_seasoning/.test(a)) {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /soy sauce|fish sauce|oyster sauce|mirin|sake|marinade|miso/i.test(l)
      );
    } else if (/broth|stock|soup_base|dash/i.test(a)) {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /\b(broth|stock|bouillon|dashi)\b/i.test(l)
      );
    } else if (/noodle/.test(a)) {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /noodle|ramen|udon|soba|rice vermicelli|pho/i.test(l)
      );
    } else if (/dough|crust/.test(a)) {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /dough|flour.*yeast|pizza dough/i.test(l)
      );
    } else if (/^sauce$|tomato_sauce/.test(a)) {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /sauce|tomato paste|marinara|pesto/i.test(l)
      );
    } else if (/cheese/.test(a)) {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /cheese|mozzarella|parmesan|cheddar|feta/i.test(l)
      );
    } else if (/rice(?![\w])|grain/.test(a)) {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /\b(rice|quinoa|couscous)\b/i.test(l)
      );
    } else if (/dressing|vinaigrette/.test(a)) {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /dressing|vinaigrette|vinegar.*oil/i.test(l)
      );
    } else if (/cream|custard|mascarpone|ricotta/.test(a)) {
      hit = lines.find(
        (l) =>
          !used.has(l) &&
          /cream|custard|mascarpone|ricotta|cream cheese/i.test(l)
      );
    }

    if (hit) {
      used.add(hit);
      out.push({ slot: raw, line: hit.trim().slice(0, 200) });
    }
  }
  return out;
}

function coreBlob(core: StructuredIngredient[]): string {
  return core.map((c) => `${c.name} ${c.original}`).join(" | ").toLowerCase();
}

export function anchorLineSatisfiedInCore(
  core: StructuredIngredient[],
  line: string
): boolean {
  const blob = coreBlob(core);
  const n = normalizeIngredientName(line).toLowerCase();
  if (n.length >= 3 && blob.includes(n)) return true;
  const toks = line
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 4);
  return toks.some((t) => blob.includes(t));
}

/** Role priority (higher index = lower priority for staying in optional when conflict). */
const ROLE_PRIORITY: Record<string, number> = {
  structure: 6,
  protein: 6,
  base: 5,
  coating: 5,
  cooking_medium: 4,
  flavor: 2,
  garnish: 1,
  flavor_base: 2,
  richness: 3,
  aroma: 2,
  optional_enhancement: 0,
};

export function rolePriority(role: string): number {
  const r = role.toLowerCase().replace(/\s+/g, "_");
  return ROLE_PRIORITY[r] ?? 1;
}

const ARTIFACT_RE = /\s*(see blog|see recipe|see note|note\s*\d+|as needed|optional:?)\s*$/i;

export function cleanupIngredientArtifacts(
  ing: StructuredIngredient
): StructuredIngredient {
  let name = ing.name.replace(ARTIFACT_RE, "").trim();
  let original = (ing.original || "").replace(ARTIFACT_RE, "").trim();
  if (/^(note|see)\s/i.test(name)) {
    const rest = name.replace(/^(note|see)\s*\d*:?\s*/i, "").trim();
    if (rest.length > 2) name = rest;
  }
  return { ...ing, name: name || ing.name, original: original || ing.original };
}

export function enforceAnchorsInCore(
  core: StructuredIngredient[],
  optional: StructuredIngredient[],
  materialized: MaterializedAnchor[]
): { core: StructuredIngredient[]; optional: StructuredIngredient[] } {
  let c = core.map(cleanupIngredientArtifacts);
  let o = optional.map(cleanupIngredientArtifacts);
  const coreKeys = new Set(
    c.map((x) => normalizeIngredientName(x.name).toLowerCase()).filter(Boolean)
  );

  for (const { line } of materialized) {
    if (anchorLineSatisfiedInCore(c, line)) continue;
    const fromOptIdx = o.findIndex((x) => anchorLineSatisfiedInCore([x], line));
    if (fromOptIdx >= 0) {
      const [moved] = o.splice(fromOptIdx, 1);
      c.push(moved);
      coreKeys.add(normalizeIngredientName(moved.name).toLowerCase());
      continue;
    }
    const parsed = coerceStructuredIngredient(line);
    if (parsed && (parsed.name || parsed.original)) {
      const k = normalizeIngredientName(parsed.name).toLowerCase();
      if (k && !coreKeys.has(k)) {
        c.push(parsed);
        coreKeys.add(k);
      }
    }
  }

  o = o.filter((x) => {
    const k = normalizeIngredientName(x.name).toLowerCase();
    return !coreKeys.has(k);
  });

  return { core: c, optional: o };
}

export function proteinInOptional(
  optional: StructuredIngredient[],
  requireProteinAnchor: boolean
): boolean {
  if (!requireProteinAnchor) return false;
  return optional.some((x) =>
    /\b(chicken|beef|pork|fish|tofu|shrimp|lamb|turkey)\b/i.test(
      `${x.name} ${x.original}`
    )
  );
}

export function cookingMediumOnlyInOptional(
  optional: StructuredIngredient[],
  anchors: string[]
): boolean {
  const needOil = anchors.some((a) =>
    /frying_oil|cooking_oil|fry/i.test(a.toLowerCase())
  );
  if (!needOil) return false;
  const oilOpt = optional.filter((x) =>
    /\b(oil|lard|ghee)\b/i.test(`${x.name} ${x.original}`)
  );
  return oilOpt.length > 0;
}

export function validateAnchorCoreCoverage(
  core: StructuredIngredient[],
  materialized: MaterializedAnchor[]
): string[] {
  const issues: string[] = [];
  for (const { slot, line } of materialized) {
    if (!anchorLineSatisfiedInCore(core, line)) {
      issues.push(
        `CORE must include dish anchor "${slot}" (e.g. match: ${line.slice(0, 70)}…)`
      );
    }
  }
  return issues;
}
