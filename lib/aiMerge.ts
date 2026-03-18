import type { ExtractedRecipe, ExtractedRecipeWithConfidence } from "./types";
import type { StructuredIngredient } from "./types";
import { groupIngredientsBySourceOverlap, buildCleanedIngredientLinesForChef } from "./recipeIngredients";
import { parseIngredientLine } from "./ingredientParser";
import { servingsDisplayLabel } from "./ingredientScale";

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
  steps: string[];
  tips: string[];
  substitutions: string[];
  estimated_time: string;
  servings: string;
  servings_base: number;
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

/**
 * Multi-source intelligent merge: send all data to OpenAI for chef-quality
 * restructure (dedupe, core/optional, substitutions, clean steps, tips).
 * Single source also runs through chef for consistent output.
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

  const servings_base = mergeServingsBase(ordered);
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
      return {
        title: chef.title,
        description: ordered
          .map((s) => s.description)
          .filter(Boolean)
          .slice(0, 2)
          .join(" ")
          .slice(0, 1500),
        ingredients: { core, optional },
        steps: chef.steps.length > 0 ? chef.steps : fallbackStepsFromSources(ordered),
        tips: chef.tips,
        substitutions: chef.substitutions,
        estimated_time: ordered[0].estimated_time || "—",
        servings: servingsDisplayLabel(servings_base),
        servings_base,
      };
    }
  }

  // Fallback: no API or chef failed — use overlap merge, no substitutions
  const ingredients = groupIngredientsBySourceOverlap(ordered);
  const fallbackSteps = fallbackStepsFromSources(ordered);
  const title =
    ordered[0].title ||
    ordered.find((s) => s.title)?.title ||
    "Merged recipe";
  const { core, optional } = applyIngredientLimits(
    ingredients.core,
    ingredients.optional
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
    steps:
      fallbackSteps.length > 0
        ? fallbackSteps
        : ordered.flatMap((s) => s.steps).slice(0, 25),
    tips: [],
    substitutions: [],
    estimated_time: ordered[0].estimated_time || "—",
    servings: servingsDisplayLabel(servings_base),
    servings_base,
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
    steps: m.steps,
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
    steps: m.steps,
    estimated_time: m.estimated_time,
    servings: m.servings,
    servings_base: m.servings_base,
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
    substitutions: m.substitutions,
    estimated_time: m.estimated_time,
    servings: m.servings,
    servings_base: m.servings_base,
  };
}
