import type { ExtractedRecipe, StructuredIngredient } from "./types";
import {
  coerceStructuredIngredient,
  parseIngredientLine,
} from "./ingredientParser";
import {
  parseServingsCount,
  servingsDisplayLabel,
} from "./ingredientScale";

const EXTRACT_SYSTEM =
  "You extract recipes and ALWAYS return valid JSON. Use structured ingredients with numeric quantities when possible.";

const EXTRACT_USER = (raw_text: string) => `Extract ANY possible recipe information from the text.

Return STRICT JSON ONLY:
{
  "title": string,
  "servings": number,
  "ingredients": [
    {
      "quantity": number | null,
      "unit": string,
      "name": string,
      "original": string
    }
  ],
  "steps": string[]
}

Rules:
* servings: positive integer (people the recipe feeds). If unknown, use 1.
* Each ingredient: quantity is a number (use decimals for fractions, e.g. 0.5 for half); unit is short (cup, tbsp, tsp, lb, g, ml, etc.) or "" if none; name is the food item only; original is the full line as written in the text.
* If you cannot parse an amount (e.g. "salt to taste", "1–2 tbsp oil"), set quantity null, unit "", name/description as the full sensible phrase, original the full line.
* DO NOT include explanation or markdown
* ALWAYS return JSON even if partial
* steps: actionable steps; empty only if no cooking steps exist

TEXT:
${raw_text.slice(0, 12000)}`;

const MEASURE_RE =
  /\b(\d+\/?\d*\s*)?(cup|cups|tbsp|tablespoon|tsp|teaspoon|oz|g|kg|gram|grams|ml|l|lb|pound|pinch|dash)\b/i;
const VERB_STEP =
  /\b(cook|mix|add|boil|simmer|bake|fry|stir|heat|pour|chop|slice|dice|combine|whisk|marinate|serve|drain|blend|roast|grill)\b/i;

function ingredientsFromParsedList(raw: unknown): StructuredIngredient[] {
  if (!Array.isArray(raw)) return [];
  const out: StructuredIngredient[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const ing = coerceStructuredIngredient(item);
    const key = (ing.original || ing.name || "").slice(0, 200);
    if (!key.trim()) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ing);
  }
  return out;
}

function heuristicRecipeFromText(raw: string): ExtractedRecipe {
  const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const ingredients: StructuredIngredient[] = [];
  const steps: string[] = [];

  for (const line of lines) {
    const L = line.trim();
    if (/^[-*•]\s+/.test(L)) {
      const text = L.replace(/^[-*•]\s+/, "");
      ingredients.push(parseIngredientLine(text));
      continue;
    }
    if (MEASURE_RE.test(L) && L.length < 200) {
      ingredients.push(parseIngredientLine(L.replace(/^[-*•]\s*/, "")));
      continue;
    }
    if (/^\d+[\).\]]\s*\S/.test(L)) {
      steps.push(L.replace(/^\d+[\).\]]\s*/, ""));
      continue;
    }
  }

  if (steps.length === 0) {
    const sentences = raw
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 25 && s.length < 500);
    for (const s of sentences) {
      if (VERB_STEP.test(s)) steps.push(s);
    }
  }

  const title =
    raw.match(/^Recipe:\s*(.+)$/im)?.[1]?.trim() ??
    lines.find((l) => l.length > 5 && l.length < 90)?.slice(0, 80) ??
    "Recipe";

  return {
    title: title || "Recipe",
    description: "",
    ingredients: ingredients.slice(0, 120),
    steps: steps.slice(0, 120),
    estimated_time: "—",
    servings: servingsDisplayLabel(1),
    servings_base: 1,
  };
}

function lastResortFromRaw(raw: string): ExtractedRecipe {
  const chunk = raw.slice(0, 12000);
  const paras = chunk
    .split(/\n\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 30 && p.length < 2000);
  const steps = paras.slice(0, 18).map((p, i) => `${i + 1}. ${p.slice(0, 500)}`);
  return {
    title: "Recipe from captured text",
    description: "",
    ingredients: [],
    steps:
      steps.length > 0
        ? steps
        : [
            "Review captured page text below or add another source to improve this recipe.",
          ],
    estimated_time: "—",
    servings: servingsDisplayLabel(1),
    servings_base: 1,
  };
}

function normalizeFromParsed(
  parsed: Record<string, unknown>,
  rawText: string
): ExtractedRecipe {
  let ingredients = ingredientsFromParsedList(parsed.ingredients);
  if (
    ingredients.length === 0 &&
    Array.isArray(parsed.ingredients) &&
    parsed.ingredients.every((x) => typeof x === "string")
  ) {
    ingredients = (parsed.ingredients as string[])
      .map((s) => parseIngredientLine(String(s).trim()))
      .filter((i) => i.original || i.name);
  }

  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const title =
    String(parsed.title ?? "").trim() ||
    (rawText.match(/^Recipe:\s*(.+)$/im)?.[1]?.trim() ?? "Recipe");

  const sbFromNum =
    typeof parsed.servings === "number" &&
    parsed.servings > 0 &&
    parsed.servings < 500
      ? Math.round(parsed.servings)
      : null;
  const servings_base =
    sbFromNum ?? parseServingsCount(parsed.servings) ?? 1;

  if (ingredients.length > 0 || steps.length > 0) {
    return {
      title: title || "Recipe",
      description: "",
      ingredients,
      steps,
      estimated_time: "—",
      servings: servingsDisplayLabel(servings_base),
      servings_base,
    };
  }

  if (rawText.length >= 80) {
    const h = heuristicRecipeFromText(rawText);
    if (h.ingredients.length || h.steps.length)
      return { ...h, title: h.title || title };
    return { ...lastResortFromRaw(rawText), title: title || "Recipe" };
  }

  return {
    title: title || "Recipe",
    description: "",
    ingredients: [],
    steps: [],
    estimated_time: "—",
    servings: servingsDisplayLabel(1),
    servings_base: 1,
  };
}

function fallbackFromMalformedAi(aiRaw: string, raw: string): ExtractedRecipe {
  const ingredients: StructuredIngredient[] = [];
  const steps: string[] = [];
  for (const line of aiRaw.split("\n")) {
    const L = line.trim();
    if (/^[-*•]\s*\S/.test(L))
      ingredients.push(parseIngredientLine(L.replace(/^[-*•]\s+/, "")));
    if (/^\d+[\).\]]\s+\S/.test(L))
      steps.push(L.replace(/^\d+[\).\]]\s+/, ""));
  }
  if (ingredients.length || steps.length) {
    return {
      title: "Recipe",
      description: "",
      ingredients,
      steps,
      estimated_time: "—",
      servings: servingsDisplayLabel(1),
      servings_base: 1,
    };
  }
  const h = heuristicRecipeFromText(raw);
  return h.ingredients.length || h.steps.length ? h : lastResortFromRaw(raw);
}

export async function extractRecipe(
  rawText: string,
  openaiApiKey: string
): Promise<ExtractedRecipe> {
  const raw = rawText.trim();
  if (!raw) {
    return {
      title: "Untitled Recipe",
      description: "",
      ingredients: [],
      steps: [],
      estimated_time: "—",
      servings: servingsDisplayLabel(1),
      servings_base: 1,
    };
  }

  if (!openaiApiKey) {
    const h = heuristicRecipeFromText(raw);
    if (h.ingredients.length || h.steps.length) return h;
    return lastResortFromRaw(raw);
  }

  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: openaiApiKey });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: EXTRACT_USER(raw) },
      ],
      response_format: { type: "json_object" },
    });
    const aiRaw = completion.choices[0]?.message?.content ?? "";

    console.log("[OpenAI] FULL RAW RESPONSE:", aiRaw);

    if (aiRaw.trim()) {
      try {
        const parsed = JSON.parse(aiRaw) as Record<string, unknown>;
        const out = normalizeFromParsed(parsed, raw);
        return out;
      } catch (parseErr) {
        console.log("[OpenAI] JSON.parse failed:", parseErr);
        return fallbackFromMalformedAi(aiRaw, raw);
      }
    }
  } catch (e) {
    console.log("[OpenAI] API error:", e instanceof Error ? e.message : e);
  }

  const h = heuristicRecipeFromText(raw);
  if (h.ingredients.length || h.steps.length) return h;
  return lastResortFromRaw(raw);
}
