import type { ExtractedRecipe } from "./types";

const EXTRACT_SYSTEM = `You are a recipe parser. Convert the given content into a single JSON object.
- If the content is a full recipe: extract title, description, ingredients, steps, time, servings.
- If the content is partial or from a short video: infer a sensible title and fill in likely ingredients and steps where possible; use empty arrays only when you cannot infer anything.
- Always return valid JSON only, no markdown or extra text.
- Your goal is to produce something usable for cooking; inference and filling gaps are allowed.`;

const EXTRACT_USER = (raw: string) => `Convert this into a clean recipe JSON:

{
  "title": "string",
  "description": "string",
  "ingredients": ["string"],
  "steps": ["string"],
  "estimated_time": "string (e.g. 45 min)",
  "servings": "string (e.g. 4)"
}

Keep it clear and usable for cooking.

Content:
${raw.slice(0, 12000)}`;

export async function extractRecipe(
  rawText: string,
  openaiApiKey: string
): Promise<ExtractedRecipe | null> {
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: openaiApiKey });

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: EXTRACT_USER(rawText) },
      ],
      response_format: { type: "json_object" },
    });
    const content = completion.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as ExtractedRecipe;
    return normalizeExtracted(parsed);
  } catch {
    return null;
  }
}

function normalizeExtracted(r: ExtractedRecipe): ExtractedRecipe {
  return {
    title: String(r?.title ?? "Untitled Recipe").trim() || "Untitled Recipe",
    description: String(r?.description ?? "").trim(),
    ingredients: Array.isArray(r?.ingredients)
      ? r.ingredients.map((i) => String(i).trim()).filter(Boolean)
      : [],
    steps: Array.isArray(r?.steps)
      ? r.steps.map((s) => String(s).trim()).filter(Boolean)
      : [],
    estimated_time: String(r?.estimated_time ?? "").trim() || "—",
    servings: String(r?.servings ?? "").trim() || "—",
  };
}
