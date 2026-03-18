import type { ExtractedRecipe, ExtractedRecipeWithConfidence } from "./types";
import { groupIngredientsBySourceOverlap } from "./recipeIngredients";
import { servingsDisplayLabel } from "./ingredientScale";

/** Stored recipe shape (DB + API) */
export type MergedRecipeOutput = {
  title: string;
  description: string;
  ingredients: {
    core: import("./types").StructuredIngredient[];
    optional: import("./types").StructuredIngredient[];
  };
  steps: string[];
  tips: string[];
  estimated_time: string;
  servings: string;
  servings_base: number;
};

const STEPS_TIPS_SYSTEM = `You are an expert recipe editor. You receive messy, duplicated cooking instructions from multiple sources (numbered lists, section titles like "For the broth", informal notes).

Your tasks:
1) Rewrite into ONE clear, ordered list of cooking steps. Remove duplicates. Convert section headings into real steps where needed (e.g. "Prepare the broth: simmer bones for 2 hours").
2) Extract tips: techniques that appear in multiple places → important tips; unique helpful notes → optional enhancements.

Return STRICT JSON only, no markdown:
{
  "steps": string[],
  "tips": string[]
}

steps must be actionable (at least 1 if any cooking content exists). tips can be empty.`;

function buildCombinedStepsBlock(
  sources: ExtractedRecipeWithConfidence[]
): string {
  return sources
    .map((s, i) => {
      const label = `[Source ${i + 1} — ${s.confidence.toUpperCase()} confidence — ${s.title}]\n`;
      const body = s.steps.length
        ? s.steps.map((t, j) => `${j + 1}. ${t}`).join("\n")
        : "(no numbered steps)";
      return label + body;
    })
    .join("\n\n---\n\n");
}

async function rewriteStepsAndExtractTips(
  combinedStepsText: string,
  openaiApiKey: string
): Promise<{ steps: string[]; tips: string[] }> {
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: openaiApiKey });
  const text = combinedStepsText.slice(0, 14000);

  console.log(
    "[merge] combined steps block length:",
    text.length,
    "| preview:",
    text.slice(0, 400).replace(/\s+/g, " ")
  );

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: STEPS_TIPS_SYSTEM },
        {
          role: "user",
          content: `Combined instructions from multiple recipe sources:\n\n${text}`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    console.log("[merge] OpenAI steps/tips RAW:", raw);

    const parsed = JSON.parse(raw) as {
      steps?: unknown;
      tips?: unknown;
    };
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const tips = Array.isArray(parsed.tips)
      ? parsed.tips.map((s) => String(s).trim()).filter(Boolean)
      : [];
    return { steps, tips };
  } catch (e) {
    console.error("[merge] steps/tips OpenAI error:", e);
    return { steps: [], tips: [] };
  }
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
 * Multi-source intelligent merge: core/optional ingredients by overlap,
 * steps rewritten from combined text (not array concat), tips extracted.
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

  if (ordered.length === 1) {
    const r = ordered[0];
    return {
      title: r.title,
      description: r.description,
      ingredients: {
        core: groupIngredientsBySourceOverlap([r]).core,
        optional: [],
      },
      steps: r.steps.map((x) => x.trim()).filter(Boolean),
      tips: [],
      estimated_time: r.estimated_time,
      servings: r.servings?.trim() || servingsDisplayLabel(servings_base),
      servings_base,
    };
  }

  const ingredients = groupIngredientsBySourceOverlap(ordered);
  const combined = buildCombinedStepsBlock(ordered);
  let steps: string[] = [];
  let tips: string[] = [];

  if (combined.trim().length > 20 && openaiApiKey?.trim()) {
    const out = await rewriteStepsAndExtractTips(combined, openaiApiKey);
    steps = out.steps;
    tips = out.tips;
  }

  if (steps.length === 0) {
    steps = fallbackStepsFromSources(ordered);
  }
  if (steps.length === 0 && ordered.some((s) => s.steps.length)) {
    steps = ordered.flatMap((s) => s.steps).slice(0, 25);
  }

  const title =
    ordered[0].title ||
    ordered.find((s) => s.title)?.title ||
    "Merged recipe";
  const description = ordered
    .map((s) => s.description)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");

  return {
    title: title.trim(),
    description: description.slice(0, 1500),
    ingredients,
    steps,
    tips,
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
    estimated_time: m.estimated_time,
    servings: m.servings,
    servings_base: m.servings_base,
  };
}
