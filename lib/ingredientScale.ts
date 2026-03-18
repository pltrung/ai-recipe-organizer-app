import type { ScaledIngredient, StructuredIngredient } from "./types";

export function roundSmart(value: number): number {
  const a = Math.abs(value);
  if (a < 1) return Math.round(value * 100) / 100;
  if (a < 10) return Math.round(value * 10) / 10;
  return Math.round(value);
}

export function scaleIngredients(
  ingredients: StructuredIngredient[],
  baseServings: number,
  targetServings: number
): ScaledIngredient[] {
  const base = Math.max(0.25, baseServings || 1);
  const target = Math.max(0.25, targetServings || 1);
  const ratio = target / base;

  return ingredients.map((i) => ({
    ...i,
    scaledQuantity:
      i.quantity !== null && i.quantity !== undefined
        ? roundSmart(i.quantity * ratio)
        : null,
  }));
}

/** Pretty-print quantity for display */
export function formatQuantity(q: number): string {
  if (Number.isInteger(q)) return String(q);
  const t = roundSmart(q);
  if (Number.isInteger(t)) return String(t);
  const s = t.toFixed(2).replace(/\.?0+$/, "");
  return s;
}

/** Display line as written / fallback from structured fields */
export function formatIngredientOriginal(ing: StructuredIngredient): string {
  const o = ing.original?.trim();
  if (o) return o;
  if (ing.quantity != null && ing.unit && ing.name) {
    return `${formatQuantity(ing.quantity)} ${ing.unit} ${ing.name}`.trim();
  }
  return ing.name?.trim() || "";
}

export function formatScaledLine(ing: ScaledIngredient): string {
  if (ing.scaledQuantity != null && ing.unit) {
    return `${formatQuantity(ing.scaledQuantity)} ${ing.unit} ${ing.name}`.trim();
  }
  return ing.original || ing.name || "";
}

export function formatOriginalLine(ing: StructuredIngredient): string {
  if (ing.original?.trim()) return ing.original.trim();
  return formatScaledLine({ ...ing, scaledQuantity: ing.quantity });
}

/**
 * Parse "4", "4 servings", "Serves 6" → positive number or null
 */
export function parseServingsCount(s: unknown): number | null {
  if (s == null) return null;
  if (typeof s === "number" && s > 0 && s < 500) return Math.round(s);
  const t = String(s).trim();
  if (!t || t === "—") return null;
  const m = t.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (n > 0 && n < 500) return Math.round(n);
  return null;
}

export function servingsDisplayLabel(base: number): string {
  const n = Math.max(1, Math.round(base));
  return n === 1 ? "1 serving" : `${n} servings`;
}
