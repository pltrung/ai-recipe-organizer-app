/**
 * Offline checks for chef-level synthesis helpers (no API).
 * Run: npx tsx scripts/chef-synthesis-scenarios.ts
 */

import { buildIngredientConsensus, consensusSuggestsCore } from "../lib/ingredientConsensus";
import { computeMergeQualityScore } from "../lib/mergeQualityScore";
import { finalizeSynthesisPayload } from "../lib/recipeOutputCleanup";
import type { Recipe, RecipeDiffStructured, SynthesisDbPayload } from "../lib/types";

function assert(name: string, ok: boolean, detail?: string) {
  if (!ok) {
    console.error(`FAIL: ${name}`, detail ?? "");
    process.exit(1);
  }
  console.log(`OK: ${name}`);
}

// 1) Multiple blog-like sources → chicken appears in multiple strong clusters
const numberedMulti = [
  { id: 0, line: "1 lb chicken thigh", sourceIndex: 0, sourceConf: "high" as const },
  { id: 1, line: "2 tbsp soy sauce", sourceIndex: 0, sourceConf: "high" as const },
  { id: 2, line: "500g chicken thighs", sourceIndex: 1, sourceConf: "high" as const },
  { id: 3, line: "soy sauce 2tbsp", sourceIndex: 1, sourceConf: "high" as const },
  { id: 4, line: "random reel garnish", sourceIndex: 2, sourceConf: "low" as const },
];
const cons = buildIngredientConsensus(numberedMulti, ["chicken"], ["chicken thigh"]);
const chickenRow = cons.find((r) => r.name.includes("chicken"));
assert(
  "multi-source core: chicken cluster has freq≥2 strong",
  Boolean(chickenRow && chickenRow.frequency >= 2),
  JSON.stringify(chickenRow)
);
assert(
  "consensusSuggestsCore chicken",
  chickenRow ? consensusSuggestsCore(chickenRow, ["chicken"]) : false
);

// 2) Weak reel only → single low line not core by consensus
const weakOnly = [
  { id: 0, line: "fancy oil drizzle", sourceIndex: 0, sourceConf: "low" as const },
];
const consWeak = buildIngredientConsensus(weakOnly, [], []);
const weakRow = consWeak[0];
assert(
  "weak-only optional bias",
  weakRow ? !consensusSuggestsCore(weakRow, []) : true
);

// 3) Merge quality reacts to step warnings
const prev: Recipe = {
  title: "T",
  description: "",
  ingredients: { core: [], optional: [] },
  steps: [{ title: "A", instructions: "x", time: "1 min", tools: [], goal: "" }],
  tips: [],
  substitutions: [],
  estimated_time: "",
  servings: "4",
  servings_base: 4,
  source_urls: [],
  source_platforms: [],
  mistakes: [],
  techniques: [],
};
const next: Recipe = {
  ...prev,
  steps: [
    {
      title: "A",
      instructions: "x",
      time: "1 min",
      tools: ["pan"],
      goal: "",
      warnings: ["Do not burn"],
      checkpoints: ["Golden crust"],
      ingredients_used: ["chicken"],
    },
  ],
  ingredients: {
    core: [{ quantity: 1, unit: "lb", name: "chicken", original: "1 lb chicken" }],
    optional: [],
  },
};
const struct: RecipeDiffStructured = {
  added_core: ["chicken"],
  removed_core: [],
  added_optional: [],
  removed_optional: [],
  moved_core_to_optional: [],
  moved_optional_to_core: [],
  steps_new: [],
  steps_removed: [],
  steps_modified: [],
  new_tips: [],
  removed_tips: [],
  new_mistakes: [],
  removed_mistakes: [],
  new_techniques: [],
  removed_techniques: [],
};
const mq = computeMergeQualityScore(prev, next, struct);
assert("merge score in range", mq.score >= 0 && mq.score <= 100);
assert("merge score bumps for warnings", mq.score >= 55);

// 4) Finalize removes optional dup of core
const raw: SynthesisDbPayload = {
  title: "X",
  description: "",
  ingredients: {
    core: [{ quantity: 1, unit: "cup", name: "milk", original: "1 cup milk" }],
    optional: [{ quantity: 2, unit: "cup", name: "milk", original: "2 cup milk" }],
  },
  steps: [
    {
      title: "Combine dry ingredients",
      instructions:
        "Whisk flour, baking powder, and salt in a large bowl until evenly combined.",
      time: "2 min",
      tools: ["whisk"],
      goal: "",
    },
    {
      title: "Combine dry ingredients",
      instructions:
        "Whisk flour, baking powder, and salt in a large bowl until evenly combined.",
      time: "2 min",
      tools: ["whisk"],
      goal: "",
    },
  ],
  tips: ["a", "a"],
  substitutionsDetailed: [],
  mistakes: [],
  techniques: [],
  estimated_time: "",
  servings: "4",
  servings_base: 4,
  recipe_quality: null,
};
const fin = finalizeSynthesisPayload(raw);
assert("dedupe optional vs core", fin.ingredients.optional.length === 0);
assert("dedupe near-identical steps", fin.steps.length === 1);
assert("dedupe tips", fin.tips.length === 1);

console.log("\nAll chef synthesis scenario checks passed.");
