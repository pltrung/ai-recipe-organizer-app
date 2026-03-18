import type { Recipe } from "./types";
import type { RecipeDiffStructured } from "./types";
import { recipeToDiffSummaryText } from "./recipeDiff";

export type AiDiffResult = {
  summary: string;
  key_improvements: string[];
};

const SYSTEM = `You help a cook DECIDE whether to apply a proposed recipe update (new source was added).

Write like a trusted editor — specific and decision-oriented.

GOOD examples (tone + specificity):
- "Mascarpone moves to core — stronger sources agree it defines the filling."
- "New warning: don’t oversoak ladyfingers or the layer turns soggy."
- "Filling step now emphasizes whipping to soft peaks for texture."
- "Variant note: lighter home version can use whipped cream instead of full mascarpone layer."

BAD: generic "recipe improved", vague "better steps", trivial wording changes, repeating the same idea.

Prioritize:
- Core ↔ optional moves (authenticity)
- Meaningful substitutions
- Stronger cooking steps (technique, timing, order)
- New warnings that prevent failure
- Style / variant notes, important tips

IGNORE: optional garnish noise, same-meaning rephrasing.

Return STRICT JSON:
{ "summary": string, "key_improvements": string[] }

Rules:
- summary: 2–4 sentences, max ~380 chars. State what materially changed and whether it’s a clear upgrade.
- key_improvements: exactly 3–5 bullets OR fewer if only 1–2 real changes. No filler. Each bullet one concrete, attributable change.`;

export async function summarizeRecipeDiffWithAi(
  prev: Recipe,
  next: Recipe,
  structured: RecipeDiffStructured,
  openaiApiKey: string
): Promise<AiDiffResult | null> {
  if (!openaiApiKey?.trim()) return null;

  const hint = [
    "Signals (use only if meaningful):",
    `core +${structured.added_core.length} / −${structured.removed_core.length}`,
    `optional→core: ${structured.moved_optional_to_core.join("; ").slice(0, 120)}`,
    `steps new/mod/removed: ${structured.steps_new.length}/${structured.steps_modified.length}/${structured.steps_removed.length}`,
    `new tips: ${structured.new_tips.length}`,
  ].join("\n");

  const prevT = recipeToDiffSummaryText(prev, 400).slice(0, 10000);
  const nextT = recipeToDiffSummaryText(next, 400).slice(0, 10000);

  const user = `BEFORE:\n${prevT}\n\n---\n\nAFTER:\n${nextT}\n\n---\n${hint}`;

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
    const summary = String(p.summary ?? "").trim().slice(0, 500);
    let key_improvements = Array.isArray(p.key_improvements)
      ? p.key_improvements.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
      : [];
    return {
      summary:
        summary ||
        "The recipe was updated with your new source.",
      key_improvements,
    };
  } catch (e) {
    console.error("[recipeDiffAi]", e);
    return null;
  }
}

/** Fallback — only substantive signals */
export function heuristicDiffSummary(
  structured: RecipeDiffStructured
): AiDiffResult {
  const key_improvements: string[] = [];

  for (const x of structured.moved_optional_to_core.slice(0, 3)) {
    key_improvements.push(`Now essential: ${x}`);
  }
  if (structured.added_core.length >= 1) {
    const notable = structured.added_core.filter(
      (s) => s.length > 2 && !/salt|pepper|water/i.test(s)
    );
    if (notable.length)
      key_improvements.push(`Core now includes: ${notable.slice(0, 3).join(", ")}`);
  }
  if (structured.removed_core.length >= 1) {
    key_improvements.push(
      `Refined core: removed or demoted ${structured.removed_core.slice(0, 2).join(", ")}`
    );
  }
  if (structured.steps_new.length >= 2 || structured.steps_modified.length >= 2) {
    key_improvements.push(
      `Steps reworked for clearer flow (${structured.steps_new.length} new / ${structured.steps_modified.length} refined)`
    );
  } else if (structured.steps_modified.length === 1) {
    const m = structured.steps_modified[0];
    if (m && (m.before.length > 20 || m.after.length > 20))
      key_improvements.push("Key step clarified for better results");
  }
  for (const t of structured.new_tips.slice(0, 2)) {
    if (t.length > 15) key_improvements.push(`Tip: ${t.slice(0, 120)}${t.length > 120 ? "…" : ""}`);
  }

  const summary =
    key_improvements.length > 0
      ? "Meaningful updates from your new source."
      : "Minor refinements; the recipe is largely unchanged.";

  return { summary, key_improvements: key_improvements.slice(0, 5) };
}
