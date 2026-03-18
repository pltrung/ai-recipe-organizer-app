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

const SYNTHESIS_FROM_RAW_SYSTEM = `You are a professional chef.

You are given the FULL raw text captured from one or more recipe webpages or sources. Blocks are separated by ---.

Your job is to read EVERYTHING and produce ONE authoritative, cookable recipe.

For ingredients:
1. CORE: required for the dish.
2. OPTIONAL: enhancements.
3. SUBSTITUTIONS: alternatives for the same role.

For steps:
- Rewrite from scratch using your finalized ingredient list.
- Actionable, ordered, beginner-friendly, with timing and tools.

For knowledge:
- tips, mistakes (warnings), techniques

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
- Use ALL sources; resolve conflicts toward the most authentic / traditional version.
- Max 18 core, max 10 optional.
- quantity null means to taste; unit may be empty.
- time_minutes per step (0 only if instant).`;

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

/**
 * Full chef synthesis from joined raw captures (not structured merge).
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

  const run = async (extraUserHint?: string) => {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYNTHESIS_FROM_RAW_SYSTEM },
        {
          role: "user",
          content:
            `Here is all captured recipe source text (blocks separated by ---). Synthesize ONE recipe:\n\n${body}` +
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
    let result = mapParsedSynthesis(parsed, fallbackTitle);

    if (!passesQualityGateRaw(result, combinedLen)) {
      raw = await run(
        "IMPORTANT: Previous output was empty. You MUST output non-empty core ingredients and clear steps when the source text describes a real recipe."
      );
      parsed = JSON.parse(raw) as Record<string, unknown>;
      result = mapParsedSynthesis(parsed, fallbackTitle);
    }

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

