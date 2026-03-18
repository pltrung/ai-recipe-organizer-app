/**
 * Parse a single ingredient line into structured quantity / unit / name.
 * Ranges (1–2 tbsp) and mixed measures → quantity null, use original.
 */

import type { StructuredIngredient } from "./types";

const UNICODE_FRAC: Record<string, number> = {
  "½": 0.5,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "¼": 0.25,
  "¾": 0.75,
  "⅛": 0.125,
};

/** Longest-first so "tablespoon" wins over "table" */
const UNIT_ALIASES: [string, string][] = [
  ["tablespoons", "tbsp"],
  ["tablespoon", "tbsp"],
  ["teaspoons", "tsp"],
  ["teaspoon", "tsp"],
  ["milliliters", "ml"],
  ["milliliter", "ml"],
  ["kilograms", "kg"],
  ["kilogram", "kg"],
  ["grams", "g"],
  ["gram", "g"],
  ["pounds", "lb"],
  ["pound", "lb"],
  ["ounces", "oz"],
  ["ounce", "oz"],
  ["tbsp", "tbsp"],
  ["tbs", "tbsp"],
  ["tsp", "tsp"],
  ["cups", "cup"],
  ["cup", "cup"],
  ["lbs", "lb"],
  ["lb", "lb"],
  ["oz", "oz"],
  ["ml", "ml"],
  ["kg", "kg"],
  ["g", "g"],
  ["l", "l"],
  ["cloves", "clove"],
  ["clove", "clove"],
  ["stalks", "stalk"],
  ["stalk", "stalk"],
  ["pieces", "piece"],
  ["piece", "piece"],
  ["pinches", "pinch"],
  ["pinch", "pinch"],
  ["dashes", "dash"],
  ["dash", "dash"],
];

const UNIT_PATTERN = UNIT_ALIASES.map(([w]) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .sort((a, b) => b.length - a.length)
  .join("|");

const SECOND_MEASURE_RE = new RegExp(
  `\\b\\d+(?:\\s+\\d+\\/\\d+|\\/\\d+)?\\s*(?:${UNIT_PATTERN})\\b`,
  "i"
);

function parseLeadingQuantity(
  s: string
): { value: number; consumed: number } | null {
  const t = s.trim();
  if (!t) return null;

  const u = t[0];
  if (u && UNICODE_FRAC[u] != null) {
    return { value: UNICODE_FRAC[u], consumed: 1 };
  }

  // "1 1/2" or "2 3/4"
  let m = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)\b/);
  if (m) {
    const v = Number(m[1]) + Number(m[2]) / Number(m[3]);
    return { value: v, consumed: m[0].length };
  }

  m = t.match(/^(\d+)\s*\/\s*(\d+)\b/);
  if (m) {
    return { value: Number(m[1]) / Number(m[2]), consumed: m[0].length };
  }

  m = t.match(/^(\d+(?:\.\d+)?)\b/);
  if (m) {
    return { value: Number(m[1]), consumed: m[0].length };
  }

  // "a pinch", "a dash" → no numeric scale (treat as unscaled)
  if (/^(a|an)\s+(pinch|dash|sprig|handful)\b/i.test(t)) {
    return null;
  }

  return null;
}

function canonicalUnit(matched: string): string {
  const low = matched.toLowerCase();
  for (const [alias, canon] of UNIT_ALIASES) {
    if (low === alias) return canon;
  }
  return low;
}

/**
 * True if text looks like a range (1–2 tbsp) — do not scale.
 */
function isRangeLine(s: string): boolean {
  return /^\d+\s*[–\-]\s*\d+\s+/i.test(s.trim());
}

export function parseIngredientLine(original: string): StructuredIngredient {
  const raw = original.replace(/\s+/g, " ").trim();
  if (!raw) {
    return { quantity: null, unit: "", name: "", original: raw };
  }

  if (/\bto taste\b/i.test(raw)) {
    return { quantity: null, unit: "", name: raw, original: raw };
  }

  if (isRangeLine(raw)) {
    return { quantity: null, unit: "", name: raw, original: raw };
  }

  const pq = parseLeadingQuantity(raw);
  if (!pq) {
    return { quantity: null, unit: "", name: raw, original: raw };
  }

  let rest = raw.slice(pq.consumed).trim();
  const reUnit = new RegExp(`^(${UNIT_PATTERN})\\b`, "i");
  const um = rest.match(reUnit);
  if (!um) {
    return { quantity: null, unit: "", name: raw, original: raw };
  }

  const unit = canonicalUnit(um[1]);
  let name = rest.slice(um[0].length).trim();
  if (!name) {
    name = raw;
    return { quantity: null, unit: "", name: raw, original: raw };
  }

  // Second measure in name → mixed units, keep original only
  if (SECOND_MEASURE_RE.test(name)) {
    return { quantity: null, unit: "", name: raw, original: raw };
  }

  return {
    quantity: pq.value,
    unit,
    name,
    original: raw,
  };
}

export function structuredIngredientToOriginalLine(i: StructuredIngredient): string {
  if (i.quantity != null && i.unit) {
    const q =
      i.quantity === Math.floor(i.quantity)
        ? String(i.quantity)
        : String(i.quantity);
    return `${q} ${i.unit} ${i.name}`.trim();
  }
  return i.original || i.name || "";
}

/** Coerce AI / DB object into StructuredIngredient */
export function coerceStructuredIngredient(input: unknown): StructuredIngredient {
  if (input == null) {
    return { quantity: null, unit: "", name: "", original: "" };
  }
  if (typeof input === "string") {
    return parseIngredientLine(input);
  }
  if (typeof input !== "object") {
    return parseIngredientLine(String(input));
  }

  const o = input as Record<string, unknown>;
  const original = String(o.original ?? "").trim();
  const name = String(o.name ?? "").trim();
  let quantity: number | null = null;
  const q = o.quantity;
  if (typeof q === "number" && !Number.isNaN(q)) {
    quantity = q;
  } else if (q !== null && q !== undefined && String(q).trim() !== "") {
    const n = parseFloat(String(q).replace(/,/g, ""));
    if (!Number.isNaN(n)) quantity = n;
  }

  let unit = String(o.unit ?? "").trim().toLowerCase();
  for (const [alias, canon] of UNIT_ALIASES) {
    if (unit === alias || unit === canon) {
      unit = canon;
      break;
    }
  }

  if (quantity != null && unit && name) {
    return {
      quantity,
      unit,
      name,
      original: original || `${quantity} ${unit} ${name}`.trim(),
    };
  }
  if (original) return parseIngredientLine(original);
  if (name) return parseIngredientLine(name);
  return {
    quantity: null,
    unit: "",
    name: original || name,
    original: original || name,
  };
}
