/**
 * Full AI synthesis: one authoritative recipe from multiple source versions.
 * Not frequency-based merge — chef decides core / optional / substitutions / steps.
 */

import type {
  ExtractedRecipeWithConfidence,
  RecipeStep,
  RecipeSubstitutionEntry,
  StructuredIngredient,
} from "./types";
import { servingsDisplayLabel } from "./ingredientScale";
import { applyIngredientPostProcess } from "./ingredientSemanticRefine";

const SYNTHESIS_SYSTEM = `You are a professional chef.

You are given multiple versions of the same recipe.

Your job is NOT to merge — your job is to DECIDE the best version.

For ingredients:
1. Identify CORE ingredients: absolutely required for the dish to be correct.
2. Identify OPTIONAL ingredients: enhancements or variations.
3. Identify SUBSTITUTIONS: ingredients that serve the same role (group alternatives).
4. Normalize naming: combine similar items (e.g. espresso + coffee → one "coffee" line with clear quantity).

For steps:
- Rewrite ALL steps from scratch using ONLY the finalized ingredient list you chose.
- Steps must be: actionable, correctly ordered, beginner-friendly, with timing and tools.

For knowledge:
- tips: useful techniques and pro tips
- mistakes: common mistakes to avoid (warnings)
- techniques: named techniques worth highlighting

Return STRICT JSON only, no markdown:
{
  "title": string,
  "servings": number,
  "ingredients": {
    "core": [{ "name": string, "quantity": number | null, "unit": string }],
    "optional": [{ "name": string, "quantity": number | null, "unit": string }]
  },
  "substitutions": [
    { "original": string, "alternatives": string[] }
  ],
  "steps": [
    {
      "title": string,
      "instructions": string,
      "time_minutes": number,
      "tools": string[],
      "goal": string
    }
  ],
  "tips": string[],
  "mistakes": string[],
  "techniques": string[]
}

Rules:
- DO NOT blindly include everything from all sources.
- Prioritize correctness and authenticity over completeness.
- If sources conflict, choose the most authentic / traditional version.
- Make it cookable in real life.
- Max 18 core ingredients, max 10 optional.
- quantity null means "to taste" or unmeasured; unit may be empty string.
- time_minutes: estimate per step (use 0 only if instant; prefer realistic numbers).`;

function ingredientFromSynth(o: Record<string, unknown>): StructuredIngredient {
  const name = String(o.name ?? "").trim();
  let quantity: number | null = null;
  const q = o.quantity;
  if (q === null || q === undefined || q === "") quantity = null;
  else if (typeof q === "number" && !Number.isNaN(q)) quantity = q;
  else {
    const n = parseFloat(String(q).replace(/,/g, ""));
    if (!Number.isNaN(n)) quantity = n;
  }
  const unit = String(o.unit ?? "").trim().toLowerCase();
  const parts = [quantity != null ? String(quantity) : "", unit, name]
    .filter(Boolean)
    .join(" ");
  const original = parts.trim() || name;
  return {
    quantity,
    unit,
    name: name || original,
    original: original || name,
  };
}

function stepFromSynth(o: Record<string, unknown>, i: number): RecipeStep | null {
  const title =
    typeof o.title === "string" && o.title.trim()
      ? o.title.trim()
      : `Step ${i + 1}`;
  const instructions =
    typeof o.instructions === "string" && o.instructions.trim()
      ? o.instructions.trim()
      : "";
  if (!instructions) return null;
  let timeMin = 0;
  if (typeof o.time_minutes === "number" && !Number.isNaN(o.time_minutes)) {
    timeMin = Math.max(0, Math.round(o.time_minutes));
  }
  const time =
    timeMin <= 0
      ? "As needed"
      : timeMin === 1
        ? "1 minute"
        : `${timeMin} minutes`;
  const tools = Array.isArray(o.tools)
    ? o.tools.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const goal =
    typeof o.goal === "string" && o.goal.trim()
      ? o.goal.trim()
      : "Complete this step before continuing.";
  return {
    title,
    instructions,
    time,
    tools,
    goal,
    ...(timeMin > 0 ? { time_minutes: timeMin } : {}),
  };
}

function buildVersionsPrompt(sources: ExtractedRecipeWithConfidence[]): string {
  return sources
    .map((s, i) => {
      const ingLines = s.ingredients
        .map((x) => x.original || [x.quantity, x.unit, x.name].filter(Boolean).join(" "))
        .filter(Boolean);
      const stepLines = s.steps.map((t, j) => `${j + 1}. ${t}`).join("\n");
      return `## Version ${i + 1} — "${s.title}" (confidence: ${s.confidence})
**Ingredients:**
${ingLines.length ? ingLines.map((l) => `- ${l}`).join("\n") : "(none listed)"}

**Steps:**
${stepLines || "(none listed)"}
`;
    })
    .join("\n\n---\n\n");
}

function countSourceIngredients(sources: ExtractedRecipeWithConfidence[]): number {
  return sources.reduce((n, s) => n + s.ingredients.length, 0);
}

/** Rough QC: must have core if sources had ingredients; must have steps if any source had steps */
function passesQualityGate(
  out: {
    ingredients: { core: StructuredIngredient[] };
    steps: RecipeStep[];
  },
  sources: ExtractedRecipeWithConfidence[]
): boolean {
  const hadIngs = countSourceIngredients(sources) > 0;
  const hadSteps = sources.some((s) => s.steps.length > 0);
  if (
    hadIngs &&
    out.ingredients.core.length === 0 &&
    out.steps.length === 0
  ) {
    return false;
  }
  if (hadSteps && out.steps.length === 0) return false;
  return true;
}

function substitutionsFromParsed(raw: unknown): RecipeSubstitutionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeSubstitutionEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t) out.push({ original: t, alternatives: [] });
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const original = String(o.original ?? o.name ?? "").trim();
      const alts = Array.isArray(o.alternatives)
        ? o.alternatives.map((a) => String(a).trim()).filter(Boolean)
        : [];
      if (original) out.push({ original, alternatives: alts });
    }
  }
  return out;
}

/**
 * Single synthesis pass from N recipe versions.
 */
export type SynthesisDbPayload = {
  title: string;
  description: string;
  ingredients: { core: StructuredIngredient[]; optional: StructuredIngredient[] };
  steps: RecipeStep[];
  tips: string[];
  substitutionsDetailed: RecipeSubstitutionEntry[];
  mistakes: string[];
  techniques: string[];
  estimated_time: string;
  servings: string;
  servings_base: number;
};

export async function synthesizeRecipeFromVersions(
  sources: ExtractedRecipeWithConfidence[],
  openaiApiKey: string
): Promise<SynthesisDbPayload | null> {
  if (sources.length === 0 || !openaiApiKey?.trim()) return null;

  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: openaiApiKey });
  const body = buildVersionsPrompt(sources).slice(0, 28000);

  const run = async (extraUserHint?: string) => {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYNTHESIS_SYSTEM },
        {
          role: "user",
          content:
            `Here are the recipe versions to synthesize into ONE authoritative recipe:\n\n${body}` +
            (extraUserHint ? `\n\n${extraUserHint}` : ""),
        },
      ],
      response_format: { type: "json_object" },
    });
    return completion.choices[0]?.message?.content ?? "";
  };

  try {
    let raw = await run();
    let parsed = JSON.parse(raw) as Record<string, unknown>;

    const mapResult = (p: Record<string, unknown>) => {
      const ing = p.ingredients as Record<string, unknown> | undefined;
      const coreRaw = Array.isArray(ing?.core) ? ing.core : [];
      const optRaw = Array.isArray(ing?.optional) ? ing.optional : [];
      const core = coreRaw
        .map((x) =>
          x && typeof x === "object"
            ? ingredientFromSynth(x as Record<string, unknown>)
            : null
        )
        .filter(
          (x): x is StructuredIngredient =>
            x != null && Boolean(x.name || x.original)
        )
        .slice(0, 18);
      const optional = optRaw
        .map((x) =>
          x && typeof x === "object"
            ? ingredientFromSynth(x as Record<string, unknown>)
            : null
        )
        .filter(
          (x): x is StructuredIngredient =>
            x != null && Boolean(x.name || x.original)
        )
        .slice(0, 10);

      const stepsRaw = Array.isArray(p.steps) ? p.steps : [];
      const steps: RecipeStep[] = [];
      for (let i = 0; i < stepsRaw.length; i++) {
        const s = stepsRaw[i];
        if (s && typeof s === "object") {
          const st = stepFromSynth(s as Record<string, unknown>, steps.length);
          if (st) steps.push(st);
        }
      }

      const tips = Array.isArray(p.tips)
        ? p.tips.map((t) => String(t).trim()).filter(Boolean)
        : [];
      const mistakes = Array.isArray(p.mistakes)
        ? p.mistakes.map((t) => String(t).trim()).filter(Boolean)
        : [];
      const techniques = Array.isArray(p.techniques)
        ? p.techniques.map((t) => String(t).trim()).filter(Boolean)
        : [];
      const substitutionsDetailed = substitutionsFromParsed(p.substitutions);

      const title =
        typeof p.title === "string" && p.title.trim()
          ? p.title.trim()
          : sources[0]?.title || "Recipe";
      let servings_base = 1;
      if (typeof p.servings === "number" && p.servings > 0 && p.servings < 500) {
        servings_base = Math.round(p.servings);
      }

      return {
        title,
        description: "",
        ingredients: { core, optional },
        steps,
        tips,
        substitutionsDetailed,
        mistakes,
        techniques,
        estimated_time: "—",
        servings: servingsDisplayLabel(servings_base),
        servings_base,
      };
    };

    let result = mapResult(parsed);
    if (!passesQualityGate(result, sources)) {
      raw = await run(
        "IMPORTANT: Previous output was incomplete. You MUST output non-empty core ingredients (if the dish needs any) and clear steps. Do not return empty arrays for core and steps when the sources contain a real recipe."
      );
      parsed = JSON.parse(raw) as Record<string, unknown>;
      result = mapResult(parsed);
    }

    const post = await applyIngredientPostProcess(
      {
        title: result.title,
        ingredients: result.ingredients,
      },
      openaiApiKey
    );
    result = { ...result, ingredients: post.ingredients };

    return {
      title: result.title,
      description: result.description,
      ingredients: result.ingredients,
      steps: result.steps,
      tips: result.tips,
      substitutionsDetailed: result.substitutionsDetailed,
      mistakes: result.mistakes,
      techniques: result.techniques,
      estimated_time: result.estimated_time,
      servings: result.servings,
      servings_base: result.servings_base,
    };
  } catch (e) {
    console.error("[synthesis] error:", e);
    return null;
  }
}

/** Stage 1: exhaustive candidate lists from raw corpus (no final decisions). */
const STAGE1_EXTRACT_SYSTEM = `You extract recipe material from raw text. Multiple sources may be separated by ---.

Return STRICT JSON only:
{
  "ingredient_candidates": string[],
  "step_candidates": string[],
  "tip_candidates": string[]
}

Rules:
- ingredient_candidates: EVERY distinct ingredient mention (full lines as written, all variants and duplicates OK). Include garnishes, sauces, spices.
- step_candidates: EVERY procedural line or fragment (numbered or not), even messy or redundant.
- tip_candidates: tips, warnings, techniques, timing notes, "chef says", common mistakes — one string per item.
- Do NOT merge or judge quality; capture comprehensively.
- Cap each array at 120 items if needed (prioritize diversity).`;

const STAGE2_CHEF_SYSTEM = `You are a professional chef.

You are given multiple versions of a recipe as CANDIDATE LISTS (ingredients, steps, tips). The same dish may appear in conflicting forms.

Your job is to decide the BEST single recipe — not to average or list everything.

INGREDIENTS:
- Identify CORE ingredients (absolutely required for an authentic, correct dish).
- Identify OPTIONAL ingredients (enhancements, garnishes, nice-to-have).
- Identify SUBSTITUTIONS: groups that serve the same role (original + alternatives).

CRITICAL:
- Do NOT rely on frequency across candidates — use culinary knowledge of the dish.
- Prioritize correctness and authenticity over including every candidate.

STEPS:
- Rewrite steps from scratch in logical order.
- Use ONLY ingredients from your finalized core + optional lists (or substitutions you defined).
- Each step must be: actionable, ordered, with time_minutes, tools[], goal, clear instructions.

TIPS / KNOWLEDGE:
- tips: pro tips
- mistakes: warnings / what to avoid
- techniques: named techniques worth highlighting

Return STRICT JSON only, no markdown:
{
  "title": string,
  "servings": number,
  "ingredients": {
    "core": [{ "name": string, "quantity": number | null, "unit": string }],
    "optional": [{ "name": string, "quantity": number | null, "unit": string }]
  },
  "substitutions": [
    { "original": string, "alternatives": string[] }
  ],
  "steps": [
    {
      "title": string,
      "instructions": string,
      "time_minutes": number,
      "tools": string[],
      "goal": string
    }
  ],
  "tips": string[],
  "mistakes": string[],
  "techniques": string[]
}

Rules:
- Max 18 core, max 10 optional.
- quantity null means to taste; unit may be empty.
- time_minutes: realistic per step (0 only if instant).
- Ingredients and steps must be mutually consistent — every ingredient used in steps must appear in core or optional (or be a stated substitution).`;

function passesQualityGateRaw(
  out: {
    ingredients: { core: StructuredIngredient[] };
    steps: RecipeStep[];
  },
  combinedLen: number
): boolean {
  if (combinedLen < 120) return true;
  if (
    out.ingredients.core.length === 0 &&
    out.steps.length === 0
  ) {
    return false;
  }
  return true;
}

function mapParsedSynthesis(
  p: Record<string, unknown>,
  fallbackTitle: string
): Omit<SynthesisDbPayload, never> {
  const ing = p.ingredients as Record<string, unknown> | undefined;
  const coreRaw = Array.isArray(ing?.core) ? ing.core : [];
  const optRaw = Array.isArray(ing?.optional) ? ing.optional : [];
  const core = coreRaw
    .map((x) =>
      x && typeof x === "object"
        ? ingredientFromSynth(x as Record<string, unknown>)
        : null
    )
    .filter(
      (x): x is StructuredIngredient =>
        x != null && Boolean(x.name || x.original)
    )
    .slice(0, 18);
  const optional = optRaw
    .map((x) =>
      x && typeof x === "object"
        ? ingredientFromSynth(x as Record<string, unknown>)
        : null
    )
    .filter(
      (x): x is StructuredIngredient =>
        x != null && Boolean(x.name || x.original)
    )
    .slice(0, 10);

  const stepsRaw = Array.isArray(p.steps) ? p.steps : [];
  const steps: RecipeStep[] = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const s = stepsRaw[i];
    if (s && typeof s === "object") {
      const st = stepFromSynth(s as Record<string, unknown>, steps.length);
      if (st) steps.push(st);
    }
  }

  const tips = Array.isArray(p.tips)
    ? p.tips.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const mistakes = Array.isArray(p.mistakes)
    ? p.mistakes.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const techniques = Array.isArray(p.techniques)
    ? p.techniques.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const substitutionsDetailed = substitutionsFromParsed(p.substitutions);

  const title =
    typeof p.title === "string" && p.title.trim()
      ? p.title.trim()
      : fallbackTitle;
  let servings_base = 1;
  if (typeof p.servings === "number" && p.servings > 0 && p.servings < 500) {
    servings_base = Math.round(p.servings);
  }

  return {
    title,
    description: "",
    ingredients: { core, optional },
    steps,
    tips,
    substitutionsDetailed,
    mistakes,
    techniques,
    estimated_time: "—",
    servings: servingsDisplayLabel(servings_base),
    servings_base,
  };
}

const MAX_CANDIDATES_PER_LIST = 120;
const MAX_CANDIDATE_CHARS = 38_000;

type Stage1Candidates = {
  ingredient_candidates: string[];
  step_candidates: string[];
  tip_candidates: string[];
};

function parseStage1Json(raw: string): Stage1Candidates | null {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const take = (k: string) =>
      Array.isArray(p[k])
        ? (p[k] as unknown[])
            .map((x) => String(x).trim())
            .filter(Boolean)
            .slice(0, MAX_CANDIDATES_PER_LIST)
        : [];
    return {
      ingredient_candidates: take("ingredient_candidates"),
      step_candidates: take("step_candidates"),
      tip_candidates: take("tip_candidates"),
    };
  } catch {
    return null;
  }
}

function formatCandidatesForChef(
  c: Stage1Candidates,
  rawFallback: string
): string {
  const fmt = (label: string, arr: string[]) =>
    arr.length
      ? `${label} (${arr.length} items):\n${arr.map((x, i) => `${i + 1}. ${x}`).join("\n")}`
      : `${label}: (none extracted)`;

  const parts = [
    fmt("INGREDIENT CANDIDATES", c.ingredient_candidates),
    fmt("STEP CANDIDATES", c.step_candidates),
    fmt("TIP / WARNING / TECHNIQUE CANDIDATES", c.tip_candidates),
  ];
  let out = parts.join("\n\n---\n\n");
  if (out.length > MAX_CANDIDATE_CHARS) {
    out = out.slice(0, MAX_CANDIDATE_CHARS) + "\n… [truncated]";
  }
  if (
    c.ingredient_candidates.length === 0 &&
    c.step_candidates.length === 0 &&
    rawFallback.trim()
  ) {
    out +=
      "\n\n---\n\nRAW SOURCE (use if candidates were empty):\n" +
      rawFallback.slice(0, 60_000);
  }
  return out;
}

const STEP_COMMON_WORDS = new Set(
  `the and then into from with each side over heat until about minutes minute hour hours
  medium large small high low simmer boil bake fry roast grill stir whisk mix combine add remove
  place cover uncover bowl pan pot oven stove skillet saucepan dutch sheet tray plate serving
  lightly golden brown soft thick thin smooth rough chopped diced minced sliced grated peeled
  optional garnish serve immediately transfer reserve leftover next finally first last once twice
  preheat reduce increase bring cool warm room temperature refrigerate freeze thaw drain rinse pat
  dry moist tender crisp done cooked through internal thermometer degrees fahrenheit celsius
  tablespoon tablespoons teaspoon teaspoons cup cups ounce ounces pound pounds gram grams ml liter
  inch inches cm half quarter thirds double recipe yield serves servings portion portions`
    .split(/\s+/)
    .filter(Boolean)
);

function buildIngredientTokenSet(
  core: StructuredIngredient[],
  optional: StructuredIngredient[]
): Set<string> {
  const s = new Set<string>();
  for (const ing of [...core, ...optional]) {
    const t = `${ing.name} ${ing.original}`.toLowerCase();
    for (const w of t.split(/\W+/)) {
      if (w.length >= 3) s.add(w);
    }
  }
  return s;
}

/**
 * Reject chef output if steps ignore core items or reference many unknown tokens.
 */
function validateChefDecisionOutput(
  mapped: ReturnType<typeof mapParsedSynthesis>,
  stage1IngredientCount: number
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const core = mapped.ingredients.core;
  const opt = mapped.ingredients.optional;
  const steps = mapped.steps;
  const stepsText = steps.map((s) => s.instructions.toLowerCase()).join(" \n ");

  if (core.length === 0 && steps.length === 0) {
    reasons.push("No core ingredients and no steps.");
    return { ok: false, reasons };
  }

  if (
    core.length === 0 &&
    steps.length >= 2 &&
    stage1IngredientCount >= 8
  ) {
    reasons.push(
      "Many ingredients appeared in sources but core is empty — assign required items to core."
    );
  }

  const ingTokens = buildIngredientTokenSet(core, opt);
  const stepWords = stepsText.match(/\b[a-z]{5,}\b/g) || [];
  const unknown = new Set<string>();
  for (const w of stepWords) {
    if (STEP_COMMON_WORDS.has(w)) continue;
    if (ingTokens.has(w)) continue;
    if (w.length > 5 && ingTokens.has(w.slice(0, -1))) continue;
    if (w.endsWith("s") && w.length > 5 && ingTokens.has(w.slice(0, -1)))
      continue;
    if (w.endsWith("es") && ingTokens.has(w.slice(0, -2))) continue;
    unknown.add(w);
  }
  if (unknown.size > 14) {
    const sample = Array.from(unknown).slice(0, 5).join(", ");
    reasons.push(
      `Steps reference many terms not in your ingredient list (e.g. ${sample}). Add missing ingredients or rewrite steps to use only listed items.`
    );
  }

  const pantryRe = /^(salt|pepper|water|ice|oil|sugar|stock|broth|spray)$/i;
  let missingCore = 0;
  const missingNames: string[] = [];
  for (const ing of core) {
    const raw = (ing.name || ing.original || "").trim();
    if (!raw || raw.length < 2) continue;
    if (pantryRe.test(raw.split(/\s+/)[0] || "")) continue;
    const lower = raw.toLowerCase();
    const toks = lower
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9]/g, ""))
      .filter((t) => t.length >= 4);
    const hit =
      toks.some((t) => stepsText.includes(t)) ||
      (lower.length >= 5 && stepsText.includes(lower));
    if (!hit) {
      missingCore++;
      if (missingNames.length < 6) missingNames.push(ing.name || raw);
    }
  }
  const allowMissing = Math.max(1, Math.ceil(core.length * 0.3));
  if (core.length >= 2 && missingCore > allowMissing) {
    reasons.push(
      `Core ingredients never appear in steps: ${missingNames.join(", ")}. Use each major core item in at least one step.`
    );
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Two-stage: (1) extract all candidates from raw corpus, (2) chef decides one authoritative recipe.
 * Validates consistency; retries stage 2 once if invalid.
 */
export async function synthesizeRecipeFromCombinedRaw(
  combinedText: string,
  openaiApiKey: string,
  fallbackTitle = "Recipe"
): Promise<SynthesisDbPayload | null> {
  const trimmed = combinedText.trim();
  if (!trimmed || !openaiApiKey?.trim()) return null;

  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: openaiApiKey });
  const body = trimmed.slice(0, 120_000);
  const combinedLen = trimmed.length;

  const runStage1 = async (hint?: string) => {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: STAGE1_EXTRACT_SYSTEM },
        {
          role: "user",
          content:
            `Extract all candidates from this recipe source text (blocks may be separated by ---):\n\n${body}` +
            (hint ? `\n\n${hint}` : ""),
        },
      ],
      response_format: { type: "json_object" },
    });
    return completion.choices[0]?.message?.content ?? "";
  };

  const runStage2 = async (chefUserContent: string, extraHint?: string) => {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: STAGE2_CHEF_SYSTEM },
        {
          role: "user",
          content:
            chefUserContent +
            (extraHint
              ? `\n\n---\n\nVALIDATION FIX REQUIRED:\n${extraHint}`
              : ""),
        },
      ],
      response_format: { type: "json_object" },
    });
    return completion.choices[0]?.message?.content ?? "";
  };

  try {
    let stage1Raw = await runStage1();
    let candidates = parseStage1Json(stage1Raw);
    if (
      !candidates ||
      (candidates.ingredient_candidates.length === 0 &&
        candidates.step_candidates.length === 0)
    ) {
      stage1Raw = await runStage1(
        "IMPORTANT: Return non-empty ingredient_candidates and step_candidates whenever the text describes a recipe."
      );
      candidates = parseStage1Json(stage1Raw);
    }
    if (!candidates) {
      candidates = {
        ingredient_candidates: [],
        step_candidates: [],
        tip_candidates: [],
      };
    }

    const stage1IngCount = candidates.ingredient_candidates.length;
    let chefInput = formatCandidatesForChef(candidates, body);
    let stage2Raw = await runStage2(chefInput);
    let parsed = JSON.parse(stage2Raw) as Record<string, unknown>;
    let result = mapParsedSynthesis(parsed, fallbackTitle);

    if (!passesQualityGateRaw(result, combinedLen)) {
      stage2Raw = await runStage2(
        chefInput,
        "Output was incomplete. Produce non-empty core ingredients and clear steps for this dish."
      );
      parsed = JSON.parse(stage2Raw) as Record<string, unknown>;
      result = mapParsedSynthesis(parsed, fallbackTitle);
    }

    let v = validateChefDecisionOutput(result, stage1IngCount);
    if (!v.ok) {
      console.warn(
        "[synthesis-from-raw] validation failed, retry stage2:",
        v.reasons.join(" | ")
      );
      stage2Raw = await runStage2(
        chefInput,
        v.reasons.join("\n")
      );
      parsed = JSON.parse(stage2Raw) as Record<string, unknown>;
      result = mapParsedSynthesis(parsed, fallbackTitle);
      v = validateChefDecisionOutput(result, stage1IngCount);
      if (!v.ok) {
        console.warn(
          "[synthesis-from-raw] validation still failing after retry; returning best effort"
        );
      }
    }

    const post = await applyIngredientPostProcess(
      { title: result.title, ingredients: result.ingredients },
      openaiApiKey
    );
    result = { ...result, ingredients: post.ingredients };

    return {
      title: result.title,
      description: result.description,
      ingredients: result.ingredients,
      steps: result.steps,
      tips: result.tips,
      substitutionsDetailed: result.substitutionsDetailed,
      mistakes: result.mistakes,
      techniques: result.techniques,
      estimated_time: result.estimated_time,
      servings: result.servings,
      servings_base: result.servings_base,
    };
  } catch (e) {
    console.error("[synthesis-from-raw] error:", e);
    return null;
  }
}

