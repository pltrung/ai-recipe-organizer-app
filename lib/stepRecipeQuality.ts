/**
 * Shared assertions for canonical step output (scenarios + validation).
 */

import type { RecipeStep, StructuredIngredient } from "./types";
import { normalizeIngredientName } from "./ingredientNormalize";

const SCAFFOLD_TITLE =
  /^(to\s+(marinate|fry|bake|simmer|cook|prep|make|assemble|chill|rest|serve|mix)|for\s+the\s+(sauce|marinade|dressing|gravy|dip|broth|batter|coating)|before\s+(you\s+)?(start|begin))/i;

export function stepListHasScaffoldingTitle(steps: RecipeStep[]): boolean {
  return steps.some((s) => SCAFFOLD_TITLE.test(s.title.trim()));
}

export function stepListHasDuplicateTitles(steps: RecipeStep[]): boolean {
  const t = steps.map((s) => s.title.toLowerCase().replace(/\s+/g, " ").trim());
  return new Set(t).size !== t.length;
}

export function coreIngredientsMentionedInSteps(
  core: StructuredIngredient[],
  steps: RecipeStep[]
): string[] {
  const text = steps
    .map((s) => `${s.title} ${s.instructions}`)
    .join(" ")
    .toLowerCase();
  const missing: string[] = [];
  for (const c of core) {
    const n = normalizeIngredientName(c.name || c.original || "")
      .toLowerCase()
      .trim();
    if (n.length < 2) continue;
    if (text.includes(n)) continue;
    const tok = n.split(/\s+/).filter((w) => w.length > 2);
    const main = tok.find((w) => w.length > 3) || tok[0];
    if (main && text.includes(main)) continue;
    missing.push(c.name || n);
  }
  return missing;
}

export type StepQualityRules = {
  minSteps?: number;
  maxSteps?: number;
  mustMention?: RegExp[];
  banScaffoldingTitles?: boolean;
  noDuplicateTitles?: boolean;
};

export function validateRecipeStepsQuality(
  steps: RecipeStep[],
  core: StructuredIngredient[],
  rules: StepQualityRules
): string[] {
  const issues: string[] = [];
  const n = steps.length;
  if (rules.minSteps != null && n < rules.minSteps) {
    issues.push(`steps ${n} < min ${rules.minSteps}`);
  }
  if (rules.maxSteps != null && n > rules.maxSteps) {
    issues.push(`steps ${n} > max ${rules.maxSteps}`);
  }
  if (rules.noDuplicateTitles !== false && stepListHasDuplicateTitles(steps)) {
    issues.push("duplicate step titles");
  }
  if (rules.banScaffoldingTitles !== false && stepListHasScaffoldingTitle(steps)) {
    issues.push("section-style step title");
  }
  if (rules.mustMention?.length) {
    const blob = steps.map((s) => `${s.title} ${s.instructions}`).join(" ").toLowerCase();
    for (const re of rules.mustMention) {
      if (!re.test(blob)) issues.push(`missing pattern ${re}`);
    }
  }
  const miss = coreIngredientsMentionedInSteps(core, steps);
  if (miss.length && core.length <= 16) {
    issues.push(`core not in steps: ${miss.slice(0, 6).join(", ")}`);
  }
  return issues;
}
