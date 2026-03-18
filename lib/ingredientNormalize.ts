/**
 * Canonical ingredient names, unit normalization, and deduplication for save + display.
 */

import type { StructuredIngredient } from "./types";
import { formatQuantity } from "./ingredientScale";

/** Ordered: longer phrases first for matching */
const SYNONYM_GROUPS: { match: string[]; canonical: string }[] = [
  { match: ["nước mắm", "nuoc mam", "nam pla"], canonical: "fish sauce" },
  { match: ["fish sauce"], canonical: "fish sauce" },
  { match: ["heavy whipping cream", "whipping cream"], canonical: "heavy cream" },
  { match: ["heavy cream"], canonical: "heavy cream" },
  { match: ["caster sugar", "castor sugar", "superfine sugar"], canonical: "sugar" },
  { match: ["white sugar", "granulated sugar", "table sugar"], canonical: "sugar" },
  { match: ["brown sugar"], canonical: "brown sugar" },
  { match: ["powdered sugar", "icing sugar", "confectioners sugar"], canonical: "powdered sugar" },
  { match: ["espresso", "strong coffee", "espresso shot"], canonical: "coffee" },
  { match: ["instant coffee"], canonical: "instant coffee" },
  { match: ["coffee"], canonical: "coffee" },
  { match: ["ladyfinger", "ladyfingers", "savoiardi", "sponge finger"], canonical: "ladyfingers" },
  { match: ["mascarpone cheese"], canonical: "mascarpone" },
  { match: ["mascarpone"], canonical: "mascarpone" },
  { match: ["cocoa powder", "unsweetened cocoa"], canonical: "cocoa powder" },
  { match: ["green onion", "spring onion", "scallion"], canonical: "green onion" },
  { match: ["cilantro", "coriander leaves", "fresh coriander"], canonical: "cilantro" },
  { match: ["ground coriander"], canonical: "ground coriander" },
  { match: ["garlic clove", "cloves garlic"], canonical: "garlic" },
  { match: ["olive oil", "extra virgin olive oil", "evoo"], canonical: "olive oil" },
  { match: ["vegetable oil", "neutral oil"], canonical: "vegetable oil" },
  { match: ["soy sauce", "light soy"], canonical: "soy sauce" },
  { match: ["dark soy"], canonical: "dark soy sauce" },
  { match: ["kosher salt", "sea salt", "table salt"], canonical: "salt" },
  { match: ["black pepper", "freshly ground black pepper"], canonical: "black pepper" },
  { match: ["all-purpose flour", "plain flour", "ap flour"], canonical: "all-purpose flour" },
  { match: ["cornstarch", "corn starch", "cornflour", "corn flour"], canonical: "cornstarch" },
  {
    match: ["chicken thigh", "chicken thighs", "boneless chicken thigh"],
    canonical: "chicken thigh",
  },
  { match: ["rice vinegar", "rice wine vinegar"], canonical: "rice vinegar" },
  { match: ["sesame oil", "toasted sesame oil"], canonical: "sesame oil" },
  { match: ["baking soda", "bicarbonate of soda"], canonical: "baking soda" },
  { match: ["baking powder"], canonical: "baking powder" },
  { match: ["unsalted butter", "salted butter"], canonical: "butter" },
  { match: ["chicken stock", "chicken broth"], canonical: "chicken broth" },
  { match: ["beef stock", "beef broth"], canonical: "beef broth" },
  { match: ["vegetable stock", "vegetable broth"], canonical: "vegetable broth" },
];

export function cleaningPipelineText(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s\u00C0-\u024F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Map similar ingredient names to a canonical display name.
 */
export function normalizeIngredientName(name: string): string {
  const raw = name?.trim() || "";
  if (!raw) return "";
  const n = cleaningPipelineText(raw);
  if (!n) return raw;

  for (const { match, canonical } of SYNONYM_GROUPS) {
    for (const phrase of match) {
      if (n === phrase || n.startsWith(phrase + " ") || n.endsWith(" " + phrase)) {
        return canonical;
      }
      if (n.includes(" " + phrase + " ") || n.includes(" " + phrase)) {
        const idx = n.indexOf(phrase);
        if (idx === 0 || n[idx - 1] === " ") {
          return canonical;
        }
      }
    }
  }

  return n;
}

const UNIT_ALIASES: [RegExp, string][] = [
  [/^(tbsp|tbs|tablespoons?|tbl)$/i, "tbsp"],
  [/^(tsp|teaspoons?)$/i, "tsp"],
  [/^(cups?)$/i, "cup"],
  [/^(oz|ounces?)$/i, "oz"],
  [/^(lb|lbs|pounds?)$/i, "lb"],
  [/^(g|grams?)$/i, "g"],
  [/^(kg|kilograms?)$/i, "kg"],
  [/^(ml|milliliters?|millilitres?)$/i, "ml"],
  [/^(l|liters?|litres?)$/i, "l"],
  [/^(pinch|pinches)$/i, "pinch"],
  [/^(cloves?)$/i, "clove"],
];

export function normalizeUnit(unit: string): string {
  const u = (unit || "").trim().toLowerCase();
  if (!u) return "";
  for (const [re, canon] of UNIT_ALIASES) {
    if (re.test(u)) return canon;
  }
  return u;
}

function dedupeKey(ing: StructuredIngredient): string {
  const unit = normalizeUnit(ing.unit || "");
  const name = normalizeIngredientName(ing.name || ing.original || "");
  return `${unit}::${name}`;
}

/**
 * Merge lines that share normalized name + unit (sum quantities).
 */
export function dedupeIngredientList(
  ings: StructuredIngredient[]
): StructuredIngredient[] {
  const map = new Map<string, StructuredIngredient>();

  for (const ing of ings) {
    const name = normalizeIngredientName(ing.name || ing.original || "") || ing.name;
    const unit = normalizeUnit(ing.unit || "") || ing.unit;
    const key = `${unit}::${name}`;
    const prev = map.get(key);

    if (!prev) {
      const original =
        ing.original?.trim() ||
        [ing.quantity != null ? formatQuantity(ing.quantity) : "", unit, name]
          .filter(Boolean)
          .join(" ")
          .trim();
      map.set(key, {
        quantity: ing.quantity,
        unit,
        name,
        original: original || name,
      });
      continue;
    }

    const q1 = prev.quantity;
    const q2 = ing.quantity;
    if (q1 != null && q2 != null && !Number.isNaN(q1) && !Number.isNaN(q2)) {
      map.set(key, {
        ...prev,
        quantity: q1 + q2,
        original:
          prev.original ||
          [formatQuantity(q1 + q2), unit, name].filter(Boolean).join(" "),
      });
    } else {
      let alt = `${key}#alt`;
      let n = 2;
      while (map.has(alt)) {
        alt = `${key}#${n++}`;
      }
      map.set(alt, {
        ...ing,
        name,
        unit: normalizeUnit(ing.unit || "") || ing.unit,
        original: ing.original || name,
      });
    }
  }

  return Array.from(map.values()).filter((i) => i.name || i.original);
}

/**
 * Dedupe core and optional separately, then canonicalize names.
 */
export function normalizeAndDedupeGroups(ingredients: {
  core: StructuredIngredient[];
  optional: StructuredIngredient[];
}): { core: StructuredIngredient[]; optional: StructuredIngredient[] } {
  return {
    core: dedupeIngredientList(ingredients.core || []),
    optional: dedupeIngredientList(ingredients.optional || []),
  };
}

const ROLE_ORDER = [
  "structure",
  "protein",
  "base",
  "coating",
  "cooking_medium",
  "flavor_base",
  "flavor",
  "richness",
  "aroma",
  "garnish",
  "optional_enhancement",
] as const;

/** Sort optional (and optionally core) by role for stable UI grouping */
export function sortIngredientsByRole(
  ings: StructuredIngredient[],
  roles: { name: string; role: string }[]
): StructuredIngredient[] {
  const roleMap = new Map<string, string>();
  for (const r of roles) {
    const k = normalizeIngredientName(r.name).toLowerCase();
    if (k) roleMap.set(k, r.role.toLowerCase());
  }
  const rank = (name: string) => {
    const k = normalizeIngredientName(name).toLowerCase();
    const ro = roleMap.get(k) ?? "zzz";
    const idx = ROLE_ORDER.indexOf(ro as (typeof ROLE_ORDER)[number]);
    return idx >= 0 ? idx : 99;
  };
  return [...ings].sort(
    (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)
  );
}
