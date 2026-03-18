import type { Recipe } from "./types";
import type { RecipeDiffStructured } from "./types";
import { recipeToDiffSummaryText } from "./recipeDiff";

export type AiDiffResult = {
  summary: string;
  key_improvements: string[];
  is_better_signal?: string;
};

function systemPrompt(mergeScore?: number, mergeReason?: string): string {
  const scoreLine =
    mergeScore != null
      ? `MERGE_QUALITY_SCORE=${mergeScore} (0–100). Reason hint: ${mergeReason || "n/a"}. If score≥62, you may say this looks like a clear upgrade; if <50, note mixed or risky changes.`
      : "";
  return `You help a cook DECIDE whether to apply a proposed recipe update (new source was added).

${scoreLine}

MATERIAL CHANGES ONLY — ignore garnish noise and same-meaning rephrasing.

Cover ONLY when present:
- Core / optional ingredient changes (moves, adds, removes)
- Step clarity (timing, order, technique, checkpoints, ingredients_used in steps)
- New warnings or critical tips
- New substitutions with real alternatives
- New variant notes

Return STRICT JSON:
{ "summary": string, "key_improvements": string[], "is_better_signal": string }

Rules:
- summary: 2–4 sentences, ~380 chars max. End with whether to trust Apply given the score.
- key_improvements: 3–5 bullets OR fewer if only 1–2 material deltas. No filler.
- is_better_signal: one short phrase echoing score (e.g. "Likely upgrade (score 72)" or "Mixed — review core list (score 48)").`;
}

export async function summarizeRecipeDiffWithAi(
  prev: Recipe,
  next: Recipe,
  structured: RecipeDiffStructured,
  openaiApiKey: string,
  mergeQuality?: { score: number; reason: string; is_proposal_better: boolean }
): Promise<AiDiffResult | null> {
  if (!openaiApiKey?.trim()) return null;

  const hint = [
    "Material signals:",
    `core +${structured.added_core.length} / −${structured.removed_core.length}`,
    `optional→core: ${structured.moved_optional_to_core.join("; ").slice(0, 120)}`,
    `steps new/mod/removed: ${structured.steps_new.length}/${structured.steps_modified.length}/${structured.steps_removed.length}`,
    `new tips/mistakes: ${structured.new_tips.length}/${structured.new_mistakes.length}`,
    mergeQuality
      ? `merge_quality_score=${mergeQuality.score} is_proposal_better=${mergeQuality.is_proposal_better}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prevT = recipeToDiffSummaryText(prev, 400).slice(0, 10000);
  const nextT = recipeToDiffSummaryText(next, 400).slice(0, 10000);

  const user = `BEFORE:\n${prevT}\n\n---\n\nAFTER:\n${nextT}\n\n---\n${hint}`;

  try {
    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: systemPrompt(mergeQuality?.score, mergeQuality?.reason),
        },
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
    const is_better_signal =
      typeof p.is_better_signal === "string"
        ? p.is_better_signal.trim().slice(0, 120)
        : undefined;
    return {
      summary:
        summary ||
        "The recipe was updated with your new source.",
      key_improvements,
      is_better_signal,
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
