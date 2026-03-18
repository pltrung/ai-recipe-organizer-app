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
  normalizeIngredientName,
  sortIngredientsByRole,
} from "./ingredientNormalize";
import { stepActionFingerprint } from "./stepFlowCanonicalization";

function stepText(s: RecipeStep): string {
  const parts = [s.title, s.instructions, ...(s.instructions_bullets ?? [])];
  return parts.join(" ").toLowerCase();
}

function wordOverlapRatio(a: string, b: string): number {
  const wa = new Set(a.split(/\W+/).filter((w) => w.length > 3));
  const wb = b.split(/\W+/).filter((w) => w.length > 3);
  if (wa.size === 0) return 0;
  let hit = 0;
  for (const w of wb) {
    if (wa.has(w)) hit++;
  }
  return hit / Math.max(wa.size, 4);
}

function stepsAreDuplicate(a: RecipeStep, b: RecipeStep): boolean {
  const ta = stepText(a).replace(/\s+/g, " ").slice(0, 220);
  const tb = stepText(b).replace(/\s+/g, " ").slice(0, 220);
  if (ta.length < 22 || tb.length < 22) return false;
  if (ta === tb) return true;
  let same = 0;
  const wa = new Set(ta.split(/\W+/).filter((w) => w.length > 3));
  for (const w of tb.split(/\W+/)) {
    if (w.length > 3 && wa.has(w)) same++;
  }
  const denom = Math.min(wa.size, 8);
  if (denom > 0 && same / denom > 0.85) return true;
  const fa = stepActionFingerprint(`${a.title} ${a.instructions}`);
  const fb = stepActionFingerprint(`${b.title} ${b.instructions}`);
  if (
    fa === fb &&
    fa !== "other" &&
    wordOverlapRatio(ta, tb) >= 0.45
  ) {
    return true;
  }
  return false;
}

export function dedupeRecipeSteps(steps: RecipeStep[]): RecipeStep[] {
  const out: RecipeStep[] = [];
  for (const s of steps) {
    if (out.some((p) => stepsAreDuplicate(p, s))) continue;
    out.push(s);
  }
  return out;
}

const SCAFFOLD_RE =
  /\b(first off|before you begin|pro tip:?|chef'?s tip:?|note:\s*|as mentioned above|see (our )?blog|in a separate (bowl|pan)|meanwhile,?\s+for the)\b/gi;

export function stripStepScaffolding(steps: RecipeStep[]): RecipeStep[] {
  return steps.map((s) => ({
    ...s,
    title: s.title.replace(/^to\s+/i, "").trim() || s.title,
    instructions: s.instructions
      .replace(SCAFFOLD_RE, "")
      .replace(/\s{2,}/g, " ")
      .trim(),
  }));
}

/** Merge back-to-back fry / marinate / coat / mix beats from stacked sources. */
export function collapseRepeatedActionSteps(
  steps: RecipeStep[]
): RecipeStep[] {
  const mergeable = new Set(["fry", "marinate", "coat", "mix", "heat_oil"]);
  const out: RecipeStep[] = [];
  for (const s of steps) {
    const body = `${s.title} ${s.instructions}`;
    const fp = stepActionFingerprint(body);
    const prev = out[out.length - 1];
    if (prev && mergeable.has(fp)) {
      const pp = stepActionFingerprint(`${prev.title} ${prev.instructions}`);
      if (pp === fp) {
        prev.instructions = `${prev.instructions.trim()} ${s.instructions.trim()}`.trim();
        const w = [...(prev.warnings ?? []), ...(s.warnings ?? [])].filter(
          Boolean
        );
        if (w.length) prev.warnings = Array.from(new Set(w)).slice(0, 4);
        continue;
      }
    }
    out.push({ ...s });
  }
  return out;
}

const MAX_INSTRUCTION_CHARS = 420;

function trimAndDedupeStepWarnings(steps: RecipeStep[]): RecipeStep[] {
  return steps.map((s) => {
    let ins = s.instructions.replace(/\s+/g, " ").trim();
    if (ins.length > MAX_INSTRUCTION_CHARS) {
      ins = ins.slice(0, MAX_INSTRUCTION_CHARS - 1).trim() + "…";
    }
    const w = s.warnings?.length
      ? Array.from(
          new Set(s.warnings.map((x) => x.trim()).filter(Boolean))
        ).slice(0, 3)
      : undefined;
    return { ...s, instructions: ins, ...(w?.length ? { warnings: w } : {}) };
  });
}

/** Dedupe + collapse repeated fry/marinate + strip blog scaffolding; cap 12. */
export function polishRecipeSteps(steps: RecipeStep[]): RecipeStep[] {
  let s = dedupeRecipeSteps([...steps]);
  s = collapseRepeatedActionSteps(s);
  s = stripStepScaffolding(s);
  s = dedupeRecipeSteps(s);
  s = trimAndDedupeStepWarnings(s);
  return s.slice(0, 12);
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
  let core = [...(payload.ingredients.core || [])];
  let optional = [...(payload.ingredients.optional || [])];
  if (opts?.ingredient_roles?.length) {
    optional = sortIngredientsByRole(optional, opts.ingredient_roles);
  }
  optional = trimOptionalList(optional, maxOpt);

  const subs = filterSubsQuality(payload.substitutionsDetailed || [], core, optional);

  let steps = dedupeRecipeSteps([...(payload.steps || [])]);
  steps = collapseRepeatedActionSteps(steps);
  steps = stripStepScaffolding(steps);
  steps = dedupeRecipeSteps(steps);
  steps = trimAndDedupeStepWarnings(steps);
  if (steps.length > 12) steps = steps.slice(0, 12);

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
