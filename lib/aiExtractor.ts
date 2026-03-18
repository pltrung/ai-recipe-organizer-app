import type { ExtractedRecipe } from "./types";

const EXTRACT_SYSTEM =
  "You extract recipes and ALWAYS return valid JSON.";

const EXTRACT_USER = (raw_text: string) => `Extract ANY possible recipe information from the text.

Return STRICT JSON ONLY:
{
  "title": string,
  "ingredients": string[],
  "steps": string[]
}

Rules:

* DO NOT include explanation or markdown
* ALWAYS return JSON even if partial
* If ingredients exist, include them
* If steps are incomplete, include them anyway
* If unclear, infer reasonable cooking steps
* DO NOT return empty arrays unless absolutely no signal exists

TEXT:
${raw_text.slice(0, 12000)}`;

const MEASURE_RE =
  /\b(\d+\/?\d*\s*)?(cup|cups|tbsp|tablespoon|tsp|teaspoon|oz|g|kg|gram|grams|ml|l|lb|pound|pinch|dash)\b/i;
const VERB_STEP =
  /\b(cook|mix|add|boil|simmer|bake|fry|stir|heat|pour|chop|slice|dice|combine|whisk|marinate|serve|drain|blend|roast|grill)\b/i;

function heuristicRecipeFromText(raw: string): ExtractedRecipe {
  const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const ingredients: string[] = [];
  const steps: string[] = [];

  for (const line of lines) {
    const L = line.trim();
    if (/^[-*•]\s+/.test(L)) {
      ingredients.push(L.replace(/^[-*•]\s+/, ""));
      continue;
    }
    if (MEASURE_RE.test(L) && L.length < 200) {
      ingredients.push(L.replace(/^[-*•]\s*/, ""));
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
    servings: "—",
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
    servings: "—",
  };
}

function normalizeFromParsed(
  parsed: Record<string, unknown>,
  rawText: string
): ExtractedRecipe {
  const ingredients = Array.isArray(parsed.ingredients)
    ? parsed.ingredients.map((i) => String(i).trim()).filter(Boolean)
    : [];
  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const title =
    String(parsed.title ?? "").trim() ||
    (rawText.match(/^Recipe:\s*(.+)$/im)?.[1]?.trim() ?? "Recipe");

  if (ingredients.length > 0 || steps.length > 0) {
    return {
      title: title || "Recipe",
      description: "",
      ingredients,
      steps,
      estimated_time: "—",
      servings: "—",
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
    servings: "—",
  };
}

function fallbackFromMalformedAi(aiRaw: string, raw: string): ExtractedRecipe {
  const ingredients: string[] = [];
  const steps: string[] = [];
  for (const line of aiRaw.split("\n")) {
    const L = line.trim();
    if (/^[-*•]\s*\S/.test(L)) ingredients.push(L.replace(/^[-*•]\s+/, ""));
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
      servings: "—",
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
      servings: "—",
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
