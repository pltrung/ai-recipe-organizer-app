import type { Recipe } from "./types";
import type { RecipeDiffStructured } from "./types";
import { recipeToDiffSummaryText } from "./recipeDiff";

export type AiDiffResult = {
  summary: string;
  key_improvements: string[];
};

const SYSTEM = `You compare BEFORE vs AFTER recipe updates (a new source was merged).

Report ONLY changes that matter to a home cook:
- An ingredient promoted to core or removed from core (authenticity)
- A meaningful new substitution option
- Major step changes: clearer order, critical timing, technique fix — NOT tiny wording edits
- One genuinely useful new tip

IGNORE:
- Optional-ingredient tweaks that don't affect the dish identity
- Rephrasing with same meaning
- Mistakes/techniques sections (ignore if present)

Return STRICT JSON only:
{
  "summary": string,
  "key_improvements": string[]
}

Rules:
- summary: 1–3 sentences, max ~400 characters. If updates are minor, say so briefly.
- key_improvements: 0–5 bullets only. Skip trivial items. Each bullet one concrete improvement.`;

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
      ? p.key_improvements.map((x) => String(x).trim()).filter(Boolean).slice(0, 6)
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
