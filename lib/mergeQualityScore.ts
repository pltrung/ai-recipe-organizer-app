/**
 * Heuristic merge quality 0–100 for trust signals in merge review.
 */

import type { Recipe } from "./types";
import type { RecipeDiffStructured } from "./types";
import { normalizeIngredientKey } from "./recipeDiff";

function coreKeys(r: Recipe): Set<string> {
  return new Set(r.ingredients.core.map((i) => normalizeIngredientKey(i)));
}

function stepClarityScore(steps: Recipe["steps"]): number {
  let s = 0;
  for (const st of steps) {
    const t = `${st.title} ${st.instructions}`.length;
    if (t > 40 && t < 450) s += 2;
    if ((st.warnings?.length ?? 0) > 0) s += 3;
    if ((st.checkpoints?.length ?? 0) > 0) s += 2;
    if ((st.ingredients_used?.length ?? 0) > 0) s += 2;
    if ((st.instructions_bullets?.length ?? 0) >= 2) s += 2;
  }
  return Math.min(40, s);
}

export function computeMergeQualityScore(
  prev: Recipe,
  next: Recipe,
  structured: RecipeDiffStructured
): { score: number; reason: string; is_proposal_better: boolean } {
  let score = 50;
  const notes: string[] = [];

  const prevCore = coreKeys(prev);
  const nextCore = coreKeys(next);
  let coreOverlap = 0;
  for (const k of Array.from(nextCore)) {
    if (prevCore.has(k)) coreOverlap++;
  }
  const coreUnion = new Set(
    Array.from(prevCore).concat(Array.from(nextCore))
  ).size;
  const coreJaccard = coreUnion ? coreOverlap / coreUnion : 1;

  if (structured.moved_optional_to_core.length >= 1) {
    score += 15;
    notes.push("core strengthened");
  }
  if (structured.added_core.length >= 2) {
    score += 10;
    notes.push("new core items");
  }
  if (coreJaccard < 0.35 && structured.removed_core.length >= 3) {
    score -= 30;
    notes.push("core reshuffled heavily");
  }

  const nextClarity = stepClarityScore(next.steps);
  const prevClarity = stepClarityScore(prev.steps);
  if (nextClarity > prevClarity + 5) {
    score += 20;
    notes.push("clearer steps");
  } else if (nextClarity + 8 < prevClarity) {
    score -= 20;
    notes.push("steps less structured");
  }

  const warnDelta =
    next.steps.reduce((n, s) => n + (s.warnings?.length ?? 0), 0) -
    prev.steps.reduce((n, s) => n + (s.warnings?.length ?? 0), 0);
  if (warnDelta >= 2) {
    score += 15;
    notes.push("more safety warnings");
  }

  const subDelta =
    (next.substitutions?.length ?? 0) - (prev.substitutions?.length ?? 0);
  if (subDelta >= 1 && (next.substitutions?.some((x) => (x.options?.length ?? 0) > 0) ?? false)) {
    score += 10;
    notes.push("substitutions richer");
  }

  const roleNext = next.recipe_quality?.ingredient_roles?.length ?? 0;
  const rolePrev = prev.recipe_quality?.ingredient_roles?.length ?? 0;
  if (roleNext > rolePrev + 2) {
    score += 10;
    notes.push("roles clearer");
  }

  if (next.steps.length > prev.steps.length + 4) {
    score -= 10;
    notes.push("more step clutter");
  }

  if (
    structured.steps_new.length + structured.steps_modified.length >
    structured.steps_removed.length + 1
  ) {
    score += 5;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const reason =
    notes.length > 0 ? notes.slice(0, 5).join("; ") : "Balanced merge signal.";
  const is_proposal_better = score >= 62;

  return { score, reason, is_proposal_better };
}
