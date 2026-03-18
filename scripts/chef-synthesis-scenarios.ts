/**
 * Chef-level synthesis + step-flow scenario checks.
 * Offline: npx tsx scripts/chef-synthesis-scenarios.ts
 * Live (OPENAI_API_KEY): full phased synthesis on multi-source fixtures.
 */

import { buildIngredientConsensus, consensusSuggestsCore } from "../lib/ingredientConsensus";
import { computeMergeQualityScore } from "../lib/mergeQualityScore";
import { finalizeSynthesisPayload, polishRecipeSteps } from "../lib/recipeOutputCleanup";
import type { SourceConfidence } from "../lib/sourceSynthesisConfidence";
import {
  actionPhaseBucket,
  clusterStepCandidates,
  stripSourceScaffoldingLine,
} from "../lib/stepFlowCanonicalization";
import { validateRecipeStepsQuality } from "../lib/stepRecipeQuality";
import type { Recipe, RecipeDiffStructured, RecipeStep, SynthesisDbPayload } from "../lib/types";

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

// 5) Canonicalization helpers
const stripped = stripSourceScaffoldingLine("To marinate: combine chicken with soy and garlic.");
assert(
  "stripSourceScaffolding removes To marinate prefix",
  !/^to\s+marinate/i.test(stripped)
);
assert("actionPhaseBucket fry", actionPhaseBucket("Deep fry until golden and crisp") === "fry");
assert("actionPhaseBucket marinate", actionPhaseBucket("Marinate overnight in fridge") === "marinate");

type TL = { line: string; sourceIdx: number; conf: SourceConfidence; weight: number };
const fryClusterLines: TL[] = [
  {
    line: "Deep fry chicken pieces in hot oil until golden brown and crispy",
    sourceIdx: 0,
    conf: "high",
    weight: 4,
  },
  {
    line: "Deep fry the chicken in hot oil until golden brown crispy texture",
    sourceIdx: 1,
    conf: "high",
    weight: 4,
  },
  { line: "Marinate chicken with soy ginger and garlic", sourceIdx: 0, conf: "high", weight: 4 },
];
const cl = clusterStepCandidates(fryClusterLines);
const fryCluster = cl.find((c) => /fry/i.test(c.representative));
assert(
  "cluster merges similar fry lines across sources",
  Boolean(fryCluster && fryCluster.lines.length >= 2),
  JSON.stringify(cl.map((c) => c.representative))
);

// 6) Polish collapses / caps bloated merge stacks
const stackedFry: RecipeStep[] = Array.from({ length: 10 }, (_, i) => ({
  title: `Fry batch ${i + 1}`,
  instructions: "Fry in hot oil until golden brown and crisp.",
  time: "4 min",
  tools: ["pot"],
  goal: "",
}));
const pol = polishRecipeSteps(stackedFry);
assert("polishRecipeSteps max 12", pol.length <= 12);

// 7) Ideal-flow validation (mock chef steps)
const tiramisuCore = [
  { quantity: 250, unit: "g", name: "mascarpone", original: "250g mascarpone" },
  { quantity: 1, unit: "cup", name: "espresso", original: "1 cup espresso" },
  { quantity: 12, unit: "", name: "ladyfingers", original: "12 ladyfingers" },
];
const tiraSteps: RecipeStep[] = [
  {
    title: "Brew and cool espresso",
    instructions:
      "Brew strong espresso or coffee and let cool. Briefly dip ladyfingers without soaking.",
    time: "15 min",
    tools: [],
    goal: "",
  },
  {
    title: "Whip mascarpone cream",
    instructions:
      "Beat mascarpone with sugar until smooth. Fold in whipped cream if using.",
    time: "10 min",
    tools: ["whisk"],
    goal: "",
  },
  {
    title: "Layer cookies and cream",
    instructions:
      "Layer dipped ladyfingers and mascarpone cream in a dish. Repeat once.",
    time: "15 min",
    tools: [],
    goal: "",
  },
  {
    title: "Chill until set",
    instructions: "Refrigerate at least 4 hours until firm. Dust with cocoa before serving.",
    time: "4 hr",
    tools: [],
    goal: "",
  },
];
const tiraIssues = validateRecipeStepsQuality(tiraSteps, tiramisuCore, {
  minSteps: 4,
  maxSteps: 12,
  mustMention: [/chill|refrigerat/i],
});
assert("tiramisu mock passes quality gate", tiraIssues.length === 0, tiraIssues.join("; "));

async function runLiveStepFlowScenarios() {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    console.log("\n(Live step-flow scenarios skipped — set OPENAI_API_KEY)");
    return;
  }
  const { synthesizeRecipeFromCombinedRawWithExtractions } = await import(
    "../lib/recipeSynthesis"
  );
  const joiner = "\n\n---\n\n";

  const scenarios: {
    name: string;
    title: string;
    chunks: string[];
    sources: string[];
    conf: SourceConfidence[];
    minSteps: number;
    maxSteps: number;
    mustMention: RegExp[];
  }[] = [
    {
      name: "karaage",
      title: "Chicken karaage",
      chunks: [
        `CHICKEN KARAAGE — Blog A\nIngredients: 1 lb chicken thigh, potato starch, cornstarch, soy sauce, ginger, garlic, sake, neutral oil.\nTo marinate: Mix chicken with soy, ginger, garlic 30 min.\nTo fry: Heat oil to 350F. Coat in starch. Fry until golden. Rest. Double fry for extra crisp.`,
        `Karaage notes — Blog B\nMarinate thighs in soy and mirin. Dredge in potato starch. Deep-fry in batches until crispy.\nAlternative: air fry 400F 12 min (lighter).`,
        `TikTok karaage\nFry fry fry then sauce`,
      ],
      sources: ["blog-a", "blog-b", "reel"],
      conf: ["high", "high", "low"],
      minSteps: 5,
      maxSteps: 12,
      mustMention: [/chicken/i, /(starch|cornstarch|potato)/i, /oil/i],
    },
    {
      name: "tiramisu",
      title: "Classic tiramisu",
      chunks: [
        `Tiramisu\nMascarpone, eggs, sugar, espresso, ladyfingers, cocoa.\nSoak cookies. Layer cream. Chill overnight.\nSoak again. Another layer. Freeze option.`,
        `Italian style\nDip savoiardi in coffee. Alternate mascarpone. Refrigerate 6 hours.`,
      ],
      sources: ["blog1", "blog2"],
      conf: ["high", "high"],
      minSteps: 4,
      maxSteps: 10,
      mustMention: [/chill|refrigerat|fridge|overnight|set/i],
    },
    {
      name: "pizza",
      title: "Neapolitan pizza",
      chunks: [
        `Pizza dough 00 flour, water, salt, yeast. Knead, rest 2h. Preheat oven 500F with steel. Stretch, top, bake 6 min.`,
        `Same dough — rest 24h cold ferment for flavor. Sauce: crushed tomatoes. Mozzarella.`,
      ],
      sources: ["a", "b"],
      conf: ["high", "high"],
      minSteps: 5,
      maxSteps: 12,
      mustMention: [/preheat|oven|bake|steel|hot/i, /dough|stretch|rest/i],
    },
    {
      name: "bun_bo_hue",
      title: "Bun bo Hue",
      chunks: [
        `Spicy beef noodle soup. Pork bones, lemongrass, shrimp paste, beef shank, bun noodles.\nSimmer broth hours. Season. Serve noodles with herbs and lime.`,
        `Hue style: annatto oil, satay, lemongrass stalks. Bowl: noodles, broth, beef, pork blood optional, herbs.`,
      ],
      sources: ["north", "central"],
      conf: ["high", "high"],
      minSteps: 6,
      maxSteps: 12,
      mustMention: [/broth|simmer|noodle|bowl|serve|assemble/i],
    },
  ];

  for (const sc of scenarios) {
    const combined = sc.chunks.join(joiner);
    const r = await synthesizeRecipeFromCombinedRawWithExtractions(
      combined,
      key,
      sc.title,
      {
        raw_texts: sc.chunks,
        sources: sc.sources,
        sourceConfidences: sc.conf,
      }
    );
    if (!r?.payload?.steps?.length) {
      console.error(`LIVE FAIL: ${sc.name} — no steps returned`);
      process.exit(1);
    }
    const steps = r.payload.steps;
    const core = r.payload.ingredients.core;
    const issues = validateRecipeStepsQuality(steps, core, {
      minSteps: sc.minSteps,
      maxSteps: sc.maxSteps,
      mustMention: sc.mustMention,
    });
    const scaffold = steps.some((s) =>
      /^(to\s+(marinate|fry)|for\s+the\s+sauce|before\s+you\s+start)/i.test(
        s.title.trim()
      )
    );
    if (issues.length || scaffold || steps.length > 12) {
      console.error(`LIVE FAIL: ${sc.name}`, { issues, steps: steps.length, scaffold });
      process.exit(1);
    }
    console.log(`OK live: ${sc.name} steps=${steps.length}`);
  }
}

void runLiveStepFlowScenarios()
  .then(() => console.log("\nAll chef synthesis scenario checks passed."))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
