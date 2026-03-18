import type {
  ExtractedRecipe,
  ExtractedRecipeWithConfidence,
  RecipeStep,
  RecipeSubstitutionEntry,
  StructuredIngredient,
} from "./types";
import {
  synthesizeRecipeFromVersions,
} from "./recipeSynthesis";
import type { SynthesisDbPayload } from "./types";
import { groupIngredientsBySourceOverlap, buildCleanedIngredientLinesForChef } from "./recipeIngredients";
import { parseIngredientLine } from "./ingredientParser";
import { servingsDisplayLabel } from "./ingredientScale";
import {
  finalizeStructuredSteps,
  fallbackStructuredSteps,
} from "./structuredSteps";
import type { SourceConfidence } from "./sourceSynthesisConfidence";
import {
  buildConfidenceSummary,
  canonicalizeStepFlow,
  fallbackCanonicalFromExpectedFlow,
  formatCanonicalPlanForPhaseD,
  type CanonicalizeResult,
} from "./stepFlowCanonicalization";
import { polishRecipeSteps } from "./recipeOutputCleanup";

const MAX_CORE_INGREDIENTS = 20;
const MAX_OPTIONAL_INGREDIENTS = 10;

/** Stored recipe shape (DB + API) */
export type MergedRecipeOutput = {
  title: string;
  description: string;
  ingredients: {
    core: StructuredIngredient[];
    optional: StructuredIngredient[];
  };
  steps: RecipeStep[];
  tips: string[];
  substitutionsDetailed: RecipeSubstitutionEntry[];
  mistakes: string[];
  techniques: string[];
  estimated_time: string;
  servings: string;
  servings_base: number;
  recipe_quality?: import("./types").RecipeQualityMeta | null;
};

const CHEF_SYSTEM = `You are a professional chef combining multiple recipes into the best possible version.

You are given multiple ingredient lists and cooking steps.

Your job:
1. Deduplicate ingredients
2. Group ingredients into:
   - Core (essential)
   - Optional (enhancements)
3. Identify substitutions:
   - If multiple ingredients serve similar roles, suggest alternatives (e.g. "Fish sauce: use soy sauce if unavailable")
4. Rewrite cooking steps:
   - Convert into clear, step-by-step instructions
   - Remove duplicates
   - Combine similar steps
   - NO section titles like "Broth" — must be actionable steps
5. Add a Tips section:
   - Highlight important techniques
   - Highlight optional improvements

Return STRICT JSON only, no markdown:
{
  "title": string,
  "ingredients": {
    "core": string[],
    "optional": string[]
  },
  "substitutions": string[],
  "steps": string[],
  "tips": string[]
}

Rules:
- Be concise
- Avoid duplication
- Optimize for clarity and usability
- Prioritize most common techniques across recipes
- Max 20 core ingredients, max 10 optional
- Each ingredient line can include quantity and unit (e.g. "2 cups flour", "1 lb beef")`;

function buildCombinedStepsBlock(
  sources: ExtractedRecipeWithConfidence[]
): string {
  return sources
    .map((s, i) => {
      const label = `[Source ${i + 1} — ${s.confidence.toUpperCase()} — ${s.title}]\n`;
      const body = s.steps.length
        ? s.steps.map((t, j) => `${j + 1}. ${t}`).join("\n")
        : "(no steps)";
      return label + body;
    })
    .join("\n\n---\n\n");
}

type ChefRestructureResult = {
  title: string;
  ingredients: { core: string[]; optional: string[] };
  substitutions: string[];
  steps: string[];
  tips: string[];
};

function stringsToSubstitutionEntries(lines: string[]): RecipeSubstitutionEntry[] {
  return lines
    .map((s) => {
      const t = s.trim();
      return {
        ingredient: t,
        options: [] as string[],
        original: t,
        alternatives: [] as string[],
      };
    })
    .filter((x) => x.ingredient);
}

async function chefRestructure(
  ingredientLines: string[],
  stepsBlock: string,
  sourceTitles: string[],
  openaiApiKey: string
): Promise<ChefRestructureResult | null> {
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: openaiApiKey });

  const ingText =
    ingredientLines.length > 0
      ? "INGREDIENTS (from multiple sources, may have duplicates):\n" +
        ingredientLines.map((l) => `- ${l}`).join("\n")
      : "(no ingredients provided)";
  const stepsText =
    stepsBlock.trim().length > 0
      ? "COOKING STEPS (from multiple sources):\n\n" + stepsBlock.slice(0, 12000)
      : "(no steps provided)";
  const titlesHint =
    sourceTitles.length > 0
      ? `\nRecipe titles from sources: ${sourceTitles.slice(0, 5).join("; ")}. Pick or combine the best title.`
      : "";

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: CHEF_SYSTEM },
        {
          role: "user",
          content: `Combine these into one clean recipe.${titlesHint}\n\n${ingText}\n\n${stepsText}`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as {
      title?: unknown;
      ingredients?: { core?: unknown; optional?: unknown };
      substitutions?: unknown;
      steps?: unknown;
      tips?: unknown;
    };

    const core = Array.isArray(parsed.ingredients?.core)
      ? parsed.ingredients.core.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const optional = Array.isArray(parsed.ingredients?.optional)
      ? parsed.ingredients.optional.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const substitutions = Array.isArray(parsed.substitutions)
      ? parsed.substitutions.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const tips = Array.isArray(parsed.tips)
      ? parsed.tips.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const title =
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim()
        : sourceTitles[0] || "Merged recipe";

    return {
      title,
      ingredients: { core, optional },
      substitutions,
      steps,
      tips,
    };
  } catch (e) {
    console.error("[merge] chef restructure error:", e);
    return null;
  }
}

function stringsToStructured(lines: string[]): StructuredIngredient[] {
  return lines.map((line) => parseIngredientLine(line));
}

function applyIngredientLimits(
  core: StructuredIngredient[],
  optional: StructuredIngredient[]
): { core: StructuredIngredient[]; optional: StructuredIngredient[] } {
  return {
    core: core.slice(0, MAX_CORE_INGREDIENTS),
    optional: optional.slice(0, MAX_OPTIONAL_INGREDIENTS),
  };
}

function fallbackStepsFromSources(
  sources: ExtractedRecipeWithConfidence[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    for (const step of s.steps) {
      const t = step.trim();
      if (t && !seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        out.push(t);
      }
    }
  }
  return out.slice(0, 40);
}

function mergeServingsBase(sources: ExtractedRecipeWithConfidence[]): number {
  const bases = sources
    .map((s) => s.servings_base)
    .filter((n): n is number => typeof n === "number" && n > 0 && n < 500);
  if (bases.length === 0) return 1;
  return Math.round(Math.max(...bases));
}

/** Final layer: canonicalize multi-source flows then structured steps */
async function applyFinalStructuredSteps(
  stepLines: string[],
  openaiApiKey: string,
  mergeCtx?: {
    ordered: ExtractedRecipeWithConfidence[];
    coreForCanon: StructuredIngredient[];
    dishTitle: string;
  }
): Promise<RecipeStep[]> {
  const lines = stepLines.map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  let canonicalSpine: string | undefined;
  let canonMetrics: CanonicalizeResult | null = null;
  if (mergeCtx?.ordered?.length && openaiApiKey?.trim()) {
    try {
      const OpenAI = (await import("openai")).default;
      const openai = new OpenAI({ apiKey: openaiApiKey });
      const mapConf = (c: string): SourceConfidence =>
        c === "high" ? "high" : c === "low" ? "low" : "medium_high";
      const extractionsFromSources = mergeCtx.ordered.map((s) => ({
        step_candidates: (s.steps ?? []).map(String).filter(Boolean).slice(0, 35),
        tip_candidates: [] as string[],
      }));
      const totalRaw = extractionsFromSources.reduce(
        (n, e) => n + e.step_candidates.length,
        0
      );
      const extractions =
        totalRaw > 0
          ? extractionsFromSources
          : [{ step_candidates: lines.slice(0, 40), tip_candidates: [] as string[] }];
      const chunks =
        totalRaw > 0
          ? mergeCtx.ordered.map((s) => ({ confidence: mapConf(s.confidence) }))
          : [{ confidence: "medium" as SourceConfidence }];
      const coreCanon =
        mergeCtx.coreForCanon.length > 0
          ? mergeCtx.coreForCanon
          : [
              {
                name: mergeCtx.dishTitle.slice(0, 80),
                quantity: null,
                unit: "",
                original: mergeCtx.dishTitle,
              },
            ];
      canonMetrics = await canonicalizeStepFlow(openai, {
        extractions,
        chunks,
        expectedFlow: [
          "Prepare and combine",
          "Main cooking",
          "Finish and serve",
        ],
        dishFamily: "other",
        dishName: mergeCtx.dishTitle,
        coreIngredients: coreCanon,
        confidenceSummary: buildConfidenceSummary(chunks),
      });
      canonicalSpine = formatCanonicalPlanForPhaseD(canonMetrics.plan);
      if (!canonicalSpine.trim()) {
        console.error(
          "[synthesis-phased:canonical-flow] FATAL: merge_intelligent_fallback empty canonical_step_plan"
        );
      }
    } catch (e) {
      console.error(
        "[synthesis-phased:canonical-flow] ERROR: canonicalization failed on merge_intelligent_fallback",
        e
      );
    }
  } else if (mergeCtx?.ordered?.length) {
    console.error(
      "[synthesis-phased:canonical-flow] ERROR: merge path missing API key — canonicalization skipped (invalid)"
    );
  }
  if (mergeCtx?.ordered?.length && !canonicalSpine?.trim()) {
    console.error(
      "[synthesis-phased:canonical-flow] FATAL: no canonical_step_plan — injecting minimal emergency spine (never author from raw step_candidates alone)"
    );
    const ep = fallbackCanonicalFromExpectedFlow([
      "Prepare and combine components",
      "Execute main cooking",
      "Finish and serve",
    ]);
    canonicalSpine = formatCanonicalPlanForPhaseD(ep);
    canonMetrics = {
      plan: ep,
      rawCandidateCount: lines.length,
      clusterCount: 0,
      secondaryFlowItemCount: 0,
      usedLlmPlan: false,
    };
  }
  const ai = await finalizeStructuredSteps(lines, openaiApiKey, {
    canonicalSpine,
  });
  const raw = ai && ai.length > 0 ? ai : fallbackStructuredSteps(lines);
  const polished = polishRecipeSteps(raw);
  if (canonMetrics) {
    console.log(
      `[synthesis-phased:canonical-flow] raw_step_candidates=${canonMetrics.rawCandidateCount} cluster_count=${canonMetrics.clusterCount} dominant_flow_stage_count=${canonMetrics.plan.dominant_flow.stages.length} secondary_flow_count=${canonMetrics.secondaryFlowItemCount} final_authored_step_count=${polished.length} path=merge_intelligent_fallback`
    );
  }
  return polished;
}

/**
 * Full intelligent synthesis first; fallback to chef + structured steps.
 */
export async function mergeRecipesIntelligent(
  sources: ExtractedRecipeWithConfidence[],
  openaiApiKey: string
): Promise<MergedRecipeOutput | null> {
  if (sources.length === 0) return null;

  const ordered = [...sources].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.confidence] - order[b.confidence];
  });

  const servings_base_fallback = mergeServingsBase(ordered);
  const hasAnySignal =
    ordered.some((s) => s.ingredients.length > 0 || s.steps.length > 0);

  if (hasAnySignal && openaiApiKey?.trim()) {
    const synth = await synthesizeRecipeFromVersions(ordered, openaiApiKey);
    if (synth) {
      return {
        title: synth.title,
        description: ordered
          .map((s) => s.description)
          .filter(Boolean)
          .slice(0, 2)
          .join(" ")
          .slice(0, 1500),
        ingredients: synth.ingredients,
        steps: synth.steps,
        tips: synth.tips,
        substitutionsDetailed: synth.substitutionsDetailed,
        mistakes: synth.mistakes,
        techniques: synth.techniques,
        estimated_time: ordered[0].estimated_time || "—",
        servings: synth.servings,
        servings_base: synth.servings_base,
        recipe_quality: synth.recipe_quality ?? null,
      };
    }
  }

  const sourceTitles = ordered.map((s) => s.title).filter(Boolean);
  const ingredientLines = buildCleanedIngredientLinesForChef(ordered);
  const stepsBlock = buildCombinedStepsBlock(ordered);
  const hasContent =
    ingredientLines.length > 0 || stepsBlock.trim().length > 20;

  if (hasContent && openaiApiKey?.trim()) {
    const chef = await chefRestructure(
      ingredientLines,
      stepsBlock,
      sourceTitles,
      openaiApiKey
    );
    if (chef) {
      const coreStructured = stringsToStructured(chef.ingredients.core);
      const optionalStructured = stringsToStructured(chef.ingredients.optional);
      const { core, optional } = applyIngredientLimits(
        coreStructured,
        optionalStructured
      );
      const stepLines =
        chef.steps.length > 0
          ? chef.steps
          : fallbackStepsFromSources(ordered);
      const steps = await applyFinalStructuredSteps(stepLines, openaiApiKey, {
        ordered,
        coreForCanon: core,
        dishTitle: chef.title || ordered[0]?.title || "Recipe",
      });
      return {
        title: chef.title,
        description: ordered
          .map((s) => s.description)
          .filter(Boolean)
          .slice(0, 2)
          .join(" ")
          .slice(0, 1500),
        ingredients: { core, optional },
        steps,
        tips: chef.tips,
        substitutionsDetailed: stringsToSubstitutionEntries(chef.substitutions),
        mistakes: [],
        techniques: [],
        estimated_time: ordered[0].estimated_time || "—",
        servings: servingsDisplayLabel(servings_base_fallback),
        servings_base: servings_base_fallback,
        recipe_quality: null,
      };
    }
  }

  const ingredients = groupIngredientsBySourceOverlap(ordered);
  const fbSteps = fallbackStepsFromSources(ordered);
  const fallbackStepLines =
    fbSteps.length > 0 ? fbSteps : ordered.flatMap((s) => s.steps).slice(0, 25);
  const title =
    ordered[0].title ||
    ordered.find((s) => s.title)?.title ||
    "Merged recipe";
  const { core, optional } = applyIngredientLimits(
    ingredients.core,
    ingredients.optional
  );

  const steps = await applyFinalStructuredSteps(
    fallbackStepLines,
    openaiApiKey || "",
    {
      ordered,
      coreForCanon: core,
      dishTitle: title.trim(),
    }
  );

  return {
    title: title.trim(),
    description: ordered
      .map((s) => s.description)
      .filter(Boolean)
      .slice(0, 2)
      .join(" ")
      .slice(0, 1500),
    ingredients: { core, optional },
    steps,
    tips: [],
    substitutionsDetailed: [],
    mistakes: [],
    techniques: [],
    estimated_time: ordered[0].estimated_time || "—",
    servings: servingsDisplayLabel(servings_base_fallback),
    servings_base: servings_base_fallback,
    recipe_quality: null,
  };
}

/** Legacy flat merge for callers expecting ExtractedRecipe */
export async function mergeRecipesWithConfidence(
  sources: ExtractedRecipeWithConfidence[],
  openaiApiKey: string
): Promise<ExtractedRecipe | null> {
  const m = await mergeRecipesIntelligent(sources, openaiApiKey);
  if (!m) return null;
  return {
    title: m.title,
    description: m.description,
    ingredients: [...m.ingredients.core, ...m.ingredients.optional],
    steps: m.steps.map((st) => st.instructions),
    estimated_time: m.estimated_time,
    servings: m.servings,
    servings_base: m.servings_base,
  };
}

export async function mergeRecipes(
  recipes: ExtractedRecipe[],
  openaiApiKey: string
): Promise<ExtractedRecipe | null> {
  if (recipes.length === 0) return null;
  if (recipes.length === 1) return recipes[0];
  const withConf: ExtractedRecipeWithConfidence[] = recipes.map((r) => ({
    ...r,
    confidence: "medium",
  }));
  const m = await mergeRecipesIntelligent(withConf, openaiApiKey);
  if (!m) return null;
  return {
    title: m.title,
    description: m.description,
    ingredients: [...m.ingredients.core, ...m.ingredients.optional],
    steps: m.steps.map((st) => st.instructions),
    estimated_time: m.estimated_time,
    servings: m.servings,
    servings_base: m.servings_base,
  };
}

export function synthesisPayloadToMerged(p: SynthesisDbPayload): MergedRecipeOutput {
  return {
    title: p.title,
    description: p.description,
    ingredients: p.ingredients,
    steps: p.steps,
    tips: p.tips,
    substitutionsDetailed: p.substitutionsDetailed,
    mistakes: p.mistakes,
    techniques: p.techniques,
    estimated_time: p.estimated_time,
    servings: p.servings,
    servings_base: p.servings_base,
    recipe_quality: p.recipe_quality ?? null,
  };
}

/** For DB insert after intelligent merge */
export function mergedOutputToDbRow(m: MergedRecipeOutput) {
  return {
    title: m.title,
    description: m.description,
    ingredients: m.ingredients,
    steps: m.steps,
    tips: m.tips,
    substitutions: m.substitutionsDetailed,
    mistakes: m.mistakes,
    techniques: m.techniques,
    estimated_time: m.estimated_time,
    servings: m.servings,
    servings_base: m.servings_base,
    recipe_quality: m.recipe_quality ?? null,
  };
}
