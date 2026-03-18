import type { ExtractedRecipe, ExtractedRecipeWithConfidence } from "./types";

const MERGE_SYSTEM = `You are a professional chef. Combine the given recipes into ONE optimized recipe.
Rules:
- Remove duplicates (ingredients and steps).
- Keep the best techniques and clearest instructions.
- Improve clarity and logical order.
- Keep it concise but complete.
Return only valid JSON, no markdown or extra text.`;

const MERGE_SYSTEM_CONFIDENCE = `You are a professional chef. You will receive recipes labeled by confidence: HIGH (trust these most), MEDIUM (use to enhance), LOW (use only as hints or inspiration).
- Prioritize HIGH-confidence recipes for structure and accuracy.
- Use MEDIUM to fill gaps and improve steps/ingredients.
- Use LOW only as hints; do not rely on them for accuracy.
- Remove duplicates. Keep the best techniques. Return only valid JSON, no markdown.`;

const MERGE_USER = (recipesJson: string) => `Combine these recipes into ONE optimized recipe.

Return this exact structure:
{
  "title": "string",
  "description": "string",
  "ingredients": ["string"],
  "steps": ["string"],
  "estimated_time": "string",
  "servings": "string"
}

Recipes:
${recipesJson}`;

function buildMergeUserWithConfidence(
  labeled: { recipe: ExtractedRecipe; confidence: string }[]
): string {
  const parts = labeled
    .map(
      (s, i) =>
        `[${s.confidence}] Source ${i + 1}:\n${JSON.stringify(s.recipe, null, 2)}`
    )
    .join("\n\n");
  return `Merge these recipes into ONE. Respect confidence: prioritize HIGH, use MEDIUM to enhance, use LOW only as hints.

${parts}

Return this exact structure:
{
  "title": "string",
  "description": "string",
  "ingredients": ["string"],
  "steps": ["string"],
  "estimated_time": "string",
  "servings": "string"
}`;
}

export async function mergeRecipesWithConfidence(
  sources: ExtractedRecipeWithConfidence[],
  openaiApiKey: string
): Promise<ExtractedRecipe | null> {
  if (sources.length === 0) return null;
  const ordered = [...sources].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.confidence] - order[b.confidence];
  });
  const labeled = ordered.map((r) => ({
    recipe: r,
    confidence: r.confidence.toUpperCase(),
  }));

  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: openaiApiKey });
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: MERGE_SYSTEM_CONFIDENCE },
        { role: "user", content: buildMergeUserWithConfidence(labeled) },
      ],
      response_format: { type: "json_object" },
    });
    const content = completion.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as ExtractedRecipe;
    return {
      title: String(parsed?.title ?? ordered[0].title).trim() || ordered[0].title,
      description: String(parsed?.description ?? "").trim(),
      ingredients: Array.isArray(parsed?.ingredients)
        ? parsed.ingredients.map((i) => String(i).trim()).filter(Boolean)
        : ordered[0].ingredients,
      steps: Array.isArray(parsed?.steps)
        ? parsed.steps.map((s) => String(s).trim()).filter(Boolean)
        : ordered[0].steps,
      estimated_time: String(parsed?.estimated_time ?? "").trim() || "—",
      servings: String(parsed?.servings ?? "").trim() || "—",
    };
  } catch {
    return null;
  }
}

export async function mergeRecipes(
  recipes: ExtractedRecipe[],
  openaiApiKey: string
): Promise<ExtractedRecipe | null> {
  if (recipes.length === 0) return null;
  if (recipes.length === 1) return recipes[0];

  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: openaiApiKey });

  try {
    const recipesJson = JSON.stringify(recipes, null, 2);
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: MERGE_SYSTEM },
        { role: "user", content: MERGE_USER(recipesJson) },
      ],
      response_format: { type: "json_object" },
    });
    const content = completion.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as ExtractedRecipe;
    return {
      title: String(parsed?.title ?? recipes[0].title).trim() || recipes[0].title,
      description: String(parsed?.description ?? "").trim(),
      ingredients: Array.isArray(parsed?.ingredients)
        ? parsed.ingredients.map((i) => String(i).trim()).filter(Boolean)
        : recipes[0].ingredients,
      steps: Array.isArray(parsed?.steps)
        ? parsed.steps.map((s) => String(s).trim()).filter(Boolean)
        : recipes[0].steps,
      estimated_time: String(parsed?.estimated_time ?? "").trim() || "—",
      servings: String(parsed?.servings ?? "").trim() || "—",
    };
  } catch {
    return null;
  }
}
