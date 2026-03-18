/**
 * Final pass before persisting synthesis: dedupe ingredients/steps, trim noise.
 */

import type {
  RecipeStep,
  RecipeSubstitutionEntry,
  StructuredIngredient,
  SynthesisDbPayload,
} from "./types";
import {
  dedupeIngredientList,
  normalizeIngredientName,
  sortIngredientsByRole,
} from "./ingredientNormalize";

function stepText(s: RecipeStep): string {
  const parts = [s.title, s.instructions, ...(s.instructions_bullets ?? [])];
  return parts.join(" ").toLowerCase();
}

function stepsAreDuplicate(a: RecipeStep, b: RecipeStep): boolean {
  const ta = stepText(a).replace(/\s+/g, " ").slice(0, 200);
  const tb = stepText(b).replace(/\s+/g, " ").slice(0, 200);
  if (ta.length < 25 || tb.length < 25) return false;
  if (ta === tb) return true;
  let same = 0;
  const wa = new Set(ta.split(/\W+/).filter((w) => w.length > 3));
  for (const w of tb.split(/\W+/)) {
    if (w.length > 3 && wa.has(w)) same++;
  }
  const denom = Math.min(wa.size, 8);
  return denom > 0 && same / denom > 0.85;
}

export function dedupeRecipeSteps(steps: RecipeStep[]): RecipeStep[] {
  const out: RecipeStep[] = [];
  for (const s of steps) {
    if (out.some((p) => stepsAreDuplicate(p, s))) continue;
    out.push(s);
  }
  return out;
}

/** Remove optional lines that duplicate core by normalized name */
export function stripOptionalDuplicatesOfCore(
  core: StructuredIngredient[],
  optional: StructuredIngredient[]
): StructuredIngredient[] {
  const coreKeys = new Set(
    core.map((c) => normalizeIngredientName(c.name || c.original || ""))
  );
  return optional.filter((o) => {
    const k = normalizeIngredientName(o.name || o.original || "");
    return k && !coreKeys.has(k);
  });
}

/** Cap optional bloat */
export function trimOptionalList(
  optional: StructuredIngredient[],
  maxItems: number
): StructuredIngredient[] {
  return optional.slice(0, maxItems);
}

function filterSubsQuality(
  subs: RecipeSubstitutionEntry[],
  core: StructuredIngredient[],
  optional: StructuredIngredient[]
): RecipeSubstitutionEntry[] {
  const out: RecipeSubstitutionEntry[] = [];
  const seenIng = new Set<string>();
  for (const s of subs) {
    const ing = normalizeIngredientName(s.ingredient).toLowerCase();
    if (!ing || seenIng.has(ing)) continue;
    seenIng.add(ing);
    const opts = (s.options ?? []).filter((o) => {
      const on = normalizeIngredientName(o).toLowerCase();
      if (!on || on === ing) return false;
      const ingToks = new Set(ing.split(/\s+/).filter((t) => t.length > 3));
      const oToks = new Set(on.split(/\s+/).filter((t) => t.length > 3));
      let overlap = 0;
      ingToks.forEach((t) => {
        if (oToks.has(t)) overlap++;
      });
      if (overlap === 0 && ingToks.size > 0 && oToks.size > 0) {
        if (!s.note?.trim()) return false;
      }
      return true;
    });
    if (opts.length === 0) continue;
    out.push({ ...s, options: opts.slice(0, 4) });
  }
  return out.slice(0, 12);
}

export function finalizeSynthesisPayload(
  payload: SynthesisDbPayload,
  opts?: {
    maxOptional?: number;
    ingredient_roles?: { name: string; role: string }[];
  }
): SynthesisDbPayload {
  const maxOpt = opts?.maxOptional ?? 14;
  let core = dedupeIngredientList(payload.ingredients.core || []);
  let optional = dedupeIngredientList(payload.ingredients.optional || []);
  if (opts?.ingredient_roles?.length) {
    optional = sortIngredientsByRole(optional, opts.ingredient_roles);
  }
  optional = stripOptionalDuplicatesOfCore(core, optional);
  optional = trimOptionalList(optional, maxOpt);

  const subs = filterSubsQuality(payload.substitutionsDetailed || [], core, optional);

  let steps = dedupeRecipeSteps([...(payload.steps || [])]);

  return {
    ...payload,
    ingredients: { core, optional },
    substitutionsDetailed: subs,
    steps,
    tips: Array.from(
      new Set((payload.tips || []).map((t) => t.trim()).filter(Boolean))
    ).slice(0, 12),
  };
}
