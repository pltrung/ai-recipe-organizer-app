import type { ExtractedRecipe } from "./types";

const MERGE_SYSTEM = `You are a professional chef. Combine the given recipes into ONE optimized recipe.
Rules:
- Remove duplicates (ingredients and steps).
- Keep the best techniques and clearest instructions.
- Improve clarity and logical order.
- Keep it concise but complete.
Return only valid JSON, no markdown or extra text.`;

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
