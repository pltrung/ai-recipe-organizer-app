/**
 * Structural diff between two recipe snapshots (after re-synthesis vs before).
 */

import type {
  Recipe,
  RecipeDiffStructured,
  RecipeStep,
  StructuredIngredient,
} from "./types";

export function normalizeIngredientKey(ing: StructuredIngredient): string {
  const raw = (ing.name || ing.original || "").toLowerCase();
  return raw
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

function displayIng(ing: StructuredIngredient): string {
  const o = ing.original?.trim();
  if (o) return o;
  const parts = [ing.quantity != null ? String(ing.quantity) : "", ing.unit, ing.name]
    .filter(Boolean)
    .join(" ");
  return parts.trim() || ing.name;
}

function ingKeyMap(
  list: StructuredIngredient[]
): Map<string, StructuredIngredient> {
  const m = new Map<string, StructuredIngredient>();
  for (const ing of list) {
    const k = normalizeIngredientKey(ing);
    if (k && !m.has(k)) m.set(k, ing);
  }
  return m;
}

export type StepDiffEntry =
  | { kind: "new"; instructions: string; title?: string }
  | { kind: "removed"; instructions: string; title?: string }
  | {
      kind: "modified";
      before: string;
      after: string;
      similarity: number;
    };

function normTip(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
}

function tokenJaccard(a: string, b: string): number {
  const words = (t: string) =>
    new Set(
      t
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 2)
    );
  const ta = words(a);
  const tb = words(b);
  if (ta.size === 0 && tb.size === 0) return a.trim() === b.trim() ? 1 : 0;
  let inter = 0;
  ta.forEach((w) => {
    if (tb.has(w)) inter += 1;
  });
  const u = ta.size + tb.size - inter;
  return u ? inter / u : 0;
}

function diffSteps(prev: RecipeStep[], next: RecipeStep[]): {
  entries: StepDiffEntry[];
  steps_new: string[];
  steps_removed: string[];
  steps_modified: { before: string; after: string }[];
} {
  const prevTexts = prev.map((s) =>
    String(s.instructions || "").trim()
  );
  const nextTexts = next.map((s) =>
    String(s.instructions || "").trim()
  );
  const prevTitles = prev.map((s) => s.title || "");
  const nextTitles = next.map((s) => s.title || "");

  const usedPrev = new Set<number>();
  const entries: StepDiffEntry[] = [];
  const steps_new: string[] = [];
  const steps_modified: { before: string; after: string }[] = [];

  const SIM_SAME = 0.9;
  const SIM_MOD = 0.48;

  for (let i = 0; i < nextTexts.length; i++) {
    const nt = nextTexts[i];
    if (!nt) continue;
    let bestJ = -1;
    let bestS = 0;
    for (let j = 0; j < prevTexts.length; j++) {
      if (usedPrev.has(j)) continue;
      const pt = prevTexts[j];
      if (!pt) continue;
      const s = Math.max(tokenJaccard(pt, nt), tokenJaccard(pt.slice(0, 400), nt.slice(0, 400)));
      if (s > bestS) {
        bestS = s;
        bestJ = j;
      }
    }
    if (bestJ >= 0 && bestS >= SIM_SAME) {
      usedPrev.add(bestJ);
      if (bestS < 0.97 && prevTexts[bestJ] !== nt) {
        steps_modified.push({ before: prevTexts[bestJ], after: nt });
        entries.push({
          kind: "modified",
          before: prevTexts[bestJ],
          after: nt,
          similarity: bestS,
        });
      }
    } else if (bestJ >= 0 && bestS >= SIM_MOD) {
      usedPrev.add(bestJ);
      steps_modified.push({ before: prevTexts[bestJ], after: nt });
      entries.push({
        kind: "modified",
        before: prevTexts[bestJ],
        after: nt,
        similarity: bestS,
      });
    } else {
      steps_new.push(nt);
      entries.push({
        kind: "new",
        instructions: nt,
        title: nextTitles[i],
      });
    }
  }

  const steps_removed: string[] = [];
  for (let j = 0; j < prevTexts.length; j++) {
    if (usedPrev.has(j)) continue;
    const pt = prevTexts[j];
    if (!pt) continue;
    steps_removed.push(pt);
    entries.push({
      kind: "removed",
      instructions: pt,
      title: prevTitles[j],
    });
  }

  return { entries, steps_new, steps_removed, steps_modified };
}

function stringListDiff(
  prev: string[],
  next: string[]
): { added: string[]; removed: string[] } {
  const pn = new Map<string, string>();
  for (const t of prev) {
    const k = normTip(t);
    if (k) pn.set(k, t);
  }
  const nn = new Map<string, string>();
  for (const t of next) {
    const k = normTip(t);
    if (k) nn.set(k, t);
  }
  const added: string[] = [];
  const removed: string[] = [];
  nn.forEach((v, k) => {
    if (!pn.has(k)) added.push(v);
  });
  pn.forEach((v, k) => {
    if (!nn.has(k)) removed.push(v);
  });
  return { added, removed };
}

/**
 * Compare previous recipe (before DB update) to synthesized next recipe.
 */
export function diffRecipes(prev: Recipe, next: Recipe): RecipeDiffStructured {
  const pc = prev.ingredients?.core ?? [];
  const po = prev.ingredients?.optional ?? [];
  const nc = next.ingredients?.core ?? [];
  const no = next.ingredients?.optional ?? [];

  const pcMap = ingKeyMap(pc);
  const poMap = ingKeyMap(po);
  const ncMap = ingKeyMap(nc);
  const noMap = ingKeyMap(no);

  const prevCoreKeys = new Set(pcMap.keys());
  const prevOptKeys = new Set(poMap.keys());
  const nextCoreKeys = new Set(ncMap.keys());
  const nextOptKeys = new Set(noMap.keys());

  const added_core: string[] = [];
  const removed_core: string[] = [];
  const added_optional: string[] = [];
  const removed_optional: string[] = [];
  const moved_core_to_optional: string[] = [];
  const moved_optional_to_core: string[] = [];

  nextCoreKeys.forEach((k) => {
    if (!k) return;
    if (prevCoreKeys.has(k)) return;
    if (prevOptKeys.has(k) && !prevCoreKeys.has(k)) {
      moved_optional_to_core.push(displayIng(noMap.get(k) || ncMap.get(k)!));
    } else if (!prevOptKeys.has(k)) {
      added_core.push(displayIng(ncMap.get(k)!));
    }
  });

  prevCoreKeys.forEach((k) => {
    if (!nextCoreKeys.has(k)) {
      if (nextOptKeys.has(k)) {
        moved_core_to_optional.push(displayIng(pcMap.get(k)!));
      } else {
        removed_core.push(displayIng(pcMap.get(k)!));
      }
    }
  });

  nextOptKeys.forEach((k) => {
    if (!k || nextCoreKeys.has(k)) return;
    if (prevCoreKeys.has(k)) return;
    if (!prevOptKeys.has(k)) {
      added_optional.push(displayIng(noMap.get(k)!));
    }
  });

  prevOptKeys.forEach((k) => {
    if (nextCoreKeys.has(k) || nextOptKeys.has(k)) return;
    removed_optional.push(displayIng(poMap.get(k)!));
  });

  const { steps_new, steps_removed, steps_modified } = diffSteps(
    prev.steps ?? [],
    next.steps ?? []
  );

  const tips = stringListDiff(prev.tips ?? [], next.tips ?? []);
  const mistakes = stringListDiff(prev.mistakes ?? [], next.mistakes ?? []);
  const tech = stringListDiff(prev.techniques ?? [], next.techniques ?? []);

  return {
    added_core,
    removed_core,
    added_optional,
    removed_optional,
    moved_core_to_optional,
    moved_optional_to_core,
    steps_new,
    steps_removed,
    steps_modified,
    new_tips: tips.added,
    removed_tips: tips.removed,
    new_mistakes: mistakes.added,
    removed_mistakes: mistakes.removed,
    new_techniques: tech.added,
    removed_techniques: tech.removed,
  };
}

/** Compact recipe for AI comparison (truncated). */
export function recipeToDiffSummaryText(r: Recipe, maxStepChars = 600): string {
  const core = (r.ingredients?.core ?? []).map(displayIng).join("; ");
  const opt = (r.ingredients?.optional ?? []).map(displayIng).join("; ");
  const steps = (r.steps ?? [])
    .map((s, i) => `${i + 1}. ${String(s.instructions || "").slice(0, maxStepChars)}`)
    .join("\n");
  const tips = (r.tips ?? []).join(" | ");
  const mistakes = (r.mistakes ?? []).join(" | ");
  const tech = (r.techniques ?? []).join(" | ");
  return [
    `Title: ${r.title}`,
    `Core: ${core.slice(0, 2500)}`,
    `Optional: ${opt.slice(0, 1200)}`,
    `Steps:\n${steps.slice(0, 8000)}`,
    `Tips: ${tips.slice(0, 1500)}`,
    `Mistakes: ${mistakes.slice(0, 1000)}`,
    `Techniques: ${tech.slice(0, 1000)}`,
  ].join("\n\n");
}

