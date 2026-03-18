import type { Recipe } from "./types";
import type { RecipeDiffStructured } from "./types";
import { recipeToDiffSummaryText } from "./recipeDiff";

export type AiDiffResult = {
  summary: string;
  key_improvements: string[];
};

const SYSTEM = `You compare two versions of the same recipe: BEFORE (older) and AFTER (updated with a new source).

Explain what IMPROVED in the updated recipe. Be concrete and useful for a home cook.

Focus on:
* Authenticity — truer to the dish, traditional ingredients or methods restored, corrections to the recipe identity
* Technique — clearer steps, better timing, tools, order of operations, pro methods
* Flavor — balance, depth, seasoning, optional enhancements that genuinely help

Do not list raw diffs or inventory changes unless they matter for one of the three areas above.

Return STRICT JSON only, no markdown:
{
  "summary": string,
  "key_improvements": string[]
}

Rules:
- summary: 2–4 sentences, engaging (max ~500 characters).
- key_improvements: 4–8 distinct bullets, each one complete sentence or phrase (no duplicates).
- If changes are minor, say so honestly with 2–3 shorter bullets.`;

export async function summarizeRecipeDiffWithAi(
  prev: Recipe,
  next: Recipe,
  structured: RecipeDiffStructured,
  openaiApiKey: string
): Promise<AiDiffResult | null> {
  if (!openaiApiKey?.trim()) return null;

  const hint = [
    "Change signals (for context only; interpret in light of authenticity, technique, flavor):",
    `core added/removed: +${structured.added_core.length} / −${structured.removed_core.length}`,
    `optional→core promotions: ${structured.moved_optional_to_core.length}`,
    `steps: +${structured.steps_new.length} new, ~${structured.steps_modified.length} refined, −${structured.steps_removed.length} removed`,
    `new tips/techniques: ${structured.new_tips.length} / ${structured.new_techniques.length}`,
  ].join("\n");

  const prevT = recipeToDiffSummaryText(prev, 500).slice(0, 12000);
  const nextT = recipeToDiffSummaryText(next, 500).slice(0, 12000);

  const user = `BEFORE (previous recipe):\n${prevT}\n\n---\n\nAFTER (updated recipe):\n${nextT}\n\n---\n${hint}`;

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
    let key_improvements = Array.isArray(p.key_improvements)
      ? p.key_improvements.map((x) => String(x).trim()).filter(Boolean).slice(0, 10)
      : [];
    if (!key_improvements.length && Array.isArray(p.ingredient_changes)) {
      key_improvements = (p.ingredient_changes as unknown[])
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 8);
    }
    return {
      summary:
        summary ||
        "The recipe was refined using your new source—see key improvements below.",
      key_improvements,
    };
  } catch (e) {
    console.error("[recipeDiffAi]", e);
    return null;
  }
}

/** Fallback when AI unavailable — still themed on authenticity, technique, flavor. */
export function heuristicDiffSummary(
  structured: RecipeDiffStructured
): AiDiffResult {
  const key_improvements: string[] = [];

  if (structured.moved_optional_to_core.length) {
    key_improvements.push(
      `Authenticity: Elevated essential ingredients to core (e.g. ${structured.moved_optional_to_core.slice(0, 2).join("; ")}) so the dish reads truer to tradition.`
    );
  }
  if (structured.added_core.length) {
    key_improvements.push(
      `Authenticity / flavor: Core list now includes ${structured.added_core.slice(0, 3).join(", ")}—likely filling gaps from the new source.`
    );
  }
  if (structured.removed_core.length) {
    key_improvements.push(
      `Authenticity: Trimmed or demoted items that didn’t belong in core (${structured.removed_core.slice(0, 2).join(", ")}).`
    );
  }
  if (structured.steps_modified.length >= 2 || structured.steps_new.length >= 2) {
    key_improvements.push(
      `Technique: Steps were rewritten or expanded (${structured.steps_modified.length} refined, ${structured.steps_new.length} new)—clearer order, timing, or methods.`
    );
  } else if (structured.steps_modified.length || structured.steps_new.length) {
    key_improvements.push(
      `Technique: Cooking steps were tightened or clarified for easier execution.`
    );
  }
  for (const t of structured.new_techniques.slice(0, 2)) {
    key_improvements.push(`Technique: Highlights “${t.slice(0, 80)}${t.length > 80 ? "…" : ""}”.`);
  }
  for (const t of structured.new_tips.slice(0, 2)) {
    key_improvements.push(
      `Flavor / technique: ${t.slice(0, 100)}${t.length > 100 ? "…" : ""}`
    );
  }
  if (structured.added_optional.length) {
    key_improvements.push(
      `Flavor: Optional add-ons (${structured.added_optional.slice(0, 2).join(", ")}) for depth or variation.`
    );
  }

  const summary =
    key_improvements.length > 0
      ? "Your new source helped sharpen authenticity, technique, and/or flavor—see the points below."
      : "Small polish across the recipe; the update keeps the dish aligned with your sources.";

  if (!key_improvements.length) {
    key_improvements.push(
      "The merged recipe reflects the combined sources; open the full recipe to compare details."
    );
  }

  return { summary, key_improvements: key_improvements.slice(0, 8) };
}
