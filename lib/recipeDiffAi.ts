import type { Recipe } from "./types";
import type { RecipeDiffStructured } from "./types";
import { recipeToDiffSummaryText } from "./recipeDiff";

export type AiDiffResult = {
  summary: string;
  ingredient_changes: string[];
  step_changes: string[];
  new_insights: string[];
};

const SYSTEM = `You compare two versions of the same recipe (before vs after adding a new source).
Be specific and helpful. Focus on what improved for the cook.
Return STRICT JSON only:
{
  "summary": string,
  "ingredient_changes": string[],
  "step_changes": string[],
  "new_insights": string[]
}
Max 5 items per array. summary max 400 characters.`;

export async function summarizeRecipeDiffWithAi(
  prev: Recipe,
  next: Recipe,
  structured: RecipeDiffStructured,
  openaiApiKey: string
): Promise<AiDiffResult | null> {
  if (!openaiApiKey?.trim()) return null;

  const hint = [
    "Structured hints:",
    `added core: ${structured.added_core.slice(0, 8).join("; ") || "(none)"}`,
    `removed core: ${structured.removed_core.slice(0, 6).join("; ") || "(none)"}`,
    `moved optional→core: ${structured.moved_optional_to_core.slice(0, 4).join("; ") || "(none)"}`,
    `new steps: ${structured.steps_new.length}, removed: ${structured.steps_removed.length}, modified: ${structured.steps_modified.length}`,
    `new tips: ${structured.new_tips.length}, new techniques: ${structured.new_techniques.length}`,
  ].join("\n");

  const prevT = recipeToDiffSummaryText(prev, 500).slice(0, 12000);
  const nextT = recipeToDiffSummaryText(next, 500).slice(0, 12000);

  const user = `PREVIOUS RECIPE:\n${prevT}\n\n---\n\nNEW RECIPE:\n${nextT}\n\n---\n${hint}\n\nSummarize what improved.`;

  try {
    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    const p = JSON.parse(raw) as Record<string, unknown>;
    const summary = String(p.summary ?? "").trim().slice(0, 600);
    const ingredient_changes = Array.isArray(p.ingredient_changes)
      ? p.ingredient_changes.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : [];
    const step_changes = Array.isArray(p.step_changes)
      ? p.step_changes.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : [];
    const new_insights = Array.isArray(p.new_insights)
      ? p.new_insights.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : [];
    return {
      summary: summary || "Recipe updated from your new source.",
      ingredient_changes,
      step_changes,
      new_insights,
    };
  } catch (e) {
    console.error("[recipeDiffAi]", e);
    return null;
  }
}

/** Fallback when AI unavailable: derive bullets from structured diff. */
export function heuristicDiffSummary(
  structured: RecipeDiffStructured
): AiDiffResult {
  const ingredient_changes: string[] = [];
  for (const x of structured.added_core.slice(0, 4)) {
    ingredient_changes.push(`Added to core: ${x}`);
  }
  for (const x of structured.removed_core.slice(0, 3)) {
    ingredient_changes.push(`Removed from core: ${x}`);
  }
  for (const x of structured.moved_optional_to_core.slice(0, 3)) {
    ingredient_changes.push(`Promoted to core: ${x}`);
  }
  const step_changes: string[] = [];
  if (structured.steps_new.length) {
    step_changes.push(`${structured.steps_new.length} new step(s) added`);
  }
  if (structured.steps_modified.length) {
    step_changes.push(`${structured.steps_modified.length} step(s) refined`);
  }
  if (structured.steps_removed.length) {
    step_changes.push(`${structured.steps_removed.length} step(s) removed or merged`);
  }
  const new_insights: string[] = [];
  for (const t of structured.new_tips.slice(0, 4)) {
    new_insights.push(`Tip: ${t.slice(0, 120)}${t.length > 120 ? "…" : ""}`);
  }
  for (const t of structured.new_techniques.slice(0, 3)) {
    new_insights.push(`Technique: ${t}`);
  }
  for (const t of structured.new_mistakes.slice(0, 2)) {
    new_insights.push(`Watch out: ${t.slice(0, 100)}`);
  }
  const summary =
    ingredient_changes.length || step_changes.length || new_insights.length
      ? "Your recipe was refined using the new source."
      : "Minor polish across ingredients or steps.";
  return { summary, ingredient_changes, step_changes, new_insights };
}
