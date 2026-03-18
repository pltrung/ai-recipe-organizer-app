/**
 * Four-phase recipe synthesis: extract per source → dish grounding →
 * ingredient decisions → step authoring. Reduces noisy merge output.
 */

import type {
  ExtractedRecipeWithConfidence,
  RecipeStep,
  RecipeSubstitutionEntry,
  StructuredIngredient,
  SynthesisDbPayload,
} from "./types";
import { servingsDisplayLabel } from "./ingredientScale";
import {
  normalizeAndDedupeGroups,
  normalizeIngredientName,
} from "./ingredientNormalize";

export type SourceChunk = { label: string; text: string };

export type PerSourceExtraction = {
  source_label: string;
  ingredient_candidates: string[];
  step_candidates: string[];
  tip_candidates: string[];
};

export type DishProfile = {
  canonical_dish_name: string;
  cuisine_style: string;
  essential_ingredients: string[];
  optional_acceptable: string[];
};

const MODEL = "gpt-4o-mini";
const MAX_TEXT_PER_SOURCE = 22_000;
const MAX_LIST = 100;

function ingredientFromJson(o: Record<string, unknown>): StructuredIngredient | null {
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
  if (!name && !original) return null;
  return {
    quantity,
    unit,
    name: name || original,
    original: original || name,
  };
}

function stepFromAuthoring(
  o: Record<string, unknown>,
  i: number
): RecipeStep | null {
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
        ? "1 min"
        : `${timeMin} min`;
  const tools = Array.isArray(o.tools)
    ? o.tools.map((t) => String(t).trim()).filter(Boolean).slice(0, 12)
    : [];
  const warnings = Array.isArray(o.warnings)
    ? o.warnings.map((w) => String(w).trim()).filter(Boolean).slice(0, 4)
    : [];
  return {
    title,
    instructions,
    time,
    tools,
    goal: warnings[0] || "",
    time_minutes: timeMin > 0 ? timeMin : undefined,
    warnings: warnings.length ? warnings : undefined,
  };
}

function substitutionsFromPhaseC(raw: unknown): RecipeSubstitutionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeSubstitutionEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const ingredient = String(o.ingredient ?? o.original ?? "").trim();
    const options = Array.isArray(o.options)
      ? o.options.map((x) => String(x).trim()).filter(Boolean)
      : Array.isArray(o.alternatives)
        ? o.alternatives.map((x) => String(x).trim()).filter(Boolean)
        : [];
    const note =
      typeof o.note === "string" && o.note.trim() ? o.note.trim() : undefined;
    if (ingredient)
      out.push({
        ingredient,
        options,
        note,
        original: ingredient,
        alternatives: options,
      });
  }
  return out.slice(0, 16);
}

async function chatJson(
  openai: InstanceType<typeof import("openai").default>,
  system: string,
  user: string
): Promise<Record<string, unknown> | null> {
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user.slice(0, 100_000) },
      ],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    console.error("[synthesis-phased] chatJson", e);
    return null;
  }
}

/** PHASE A — per-source candidates only */
async function phaseAExtract(
  openai: InstanceType<typeof import("openai").default>,
  chunks: SourceChunk[]
): Promise<PerSourceExtraction[] | null> {
  const trimmed = chunks.map((c) => ({
    label: c.label.slice(0, 500),
    text: c.text.slice(0, MAX_TEXT_PER_SOURCE),
  }));

  const system = `You extract recipe material from MULTIPLE sources. Each source is independent.

Return STRICT JSON:
{ "sources": [
  {
    "ingredient_candidates": string[],
    "step_candidates": string[],
    "tip_candidates": string[]
  }
] }

Rules:
- sources[] MUST have exactly the same length and order as the input sources.
- ingredient_candidates: every distinct ingredient line/mention from THAT source only. No core/optional split.
- step_candidates: procedural fragments from THAT source. Do NOT write final steps.
- tip_candidates: tips, warnings, timing notes from THAT source.
- Cap each array at ${MAX_LIST} items per source.
- Do NOT merge across sources.`;

  const user = `Sources (JSON array, same order as output):\n${JSON.stringify(trimmed.map((t, i) => ({ index: i, label: t.label, text: t.text })))}`;

  const p = await chatJson(openai, system, user);
  if (!p || !Array.isArray(p.sources)) return null;
  const arr = p.sources as unknown[];
  const out: PerSourceExtraction[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    const row = arr[i];
    const take = (k: string, o: Record<string, unknown>) =>
      Array.isArray(o[k])
        ? (o[k] as unknown[])
            .map((x) => String(x).trim())
            .filter(Boolean)
            .slice(0, MAX_LIST)
        : [];
    if (row && typeof row === "object") {
      const o = row as Record<string, unknown>;
      out.push({
        source_label: trimmed[i]!.label,
        ingredient_candidates: take("ingredient_candidates", o),
        step_candidates: take("step_candidates", o),
        tip_candidates: take("tip_candidates", o),
      });
    } else {
      out.push({
        source_label: trimmed[i]!.label,
        ingredient_candidates: [],
        step_candidates: [],
        tip_candidates: [],
      });
    }
  }
  return out;
}

/** PHASE B — dish profile */
async function phaseBDishProfile(
  openai: InstanceType<typeof import("openai").default>,
  allIngredients: string[],
  fallbackTitle: string
): Promise<DishProfile | null> {
  const uniq = Array.from(
    new Set(allIngredients.map((x) => x.trim()).filter(Boolean))
  ).slice(0, 180);
  const system = `You are a culinary expert. Given raw ingredient mentions from one or more sources about the SAME dish, infer the dish identity.

Return STRICT JSON:
{
  "canonical_dish_name": string,
  "cuisine_style": string,
  "essential_ingredients": string[],
  "optional_acceptable": string[]
}

essential_ingredients: items that define this dish (e.g. tiramisu → ladyfingers, mascarpone, coffee, cocoa, sugar). Short noun phrases.
optional_acceptable: common optional add-ons (not defining).
Use knowledge of the dish — not vote counting.`;

  const user = `Working title hint: "${fallbackTitle}"\n\nIngredient mentions (noisy list):\n${uniq.map((x, i) => `${i + 1}. ${x}`).join("\n")}`;

  const p = await chatJson(openai, system, user);
  if (!p) return null;
  const take = (k: string) =>
    Array.isArray(p[k])
      ? (p[k] as unknown[]).map((x) => String(x).trim()).filter(Boolean).slice(0, 24)
      : [];
  return {
    canonical_dish_name: String(p.canonical_dish_name ?? fallbackTitle).trim() || fallbackTitle,
    cuisine_style: String(p.cuisine_style ?? "").trim() || "—",
    essential_ingredients: take("essential_ingredients"),
    optional_acceptable: take("optional_acceptable"),
  };
}

function essentialCoverage(
  core: StructuredIngredient[],
  essentials: string[]
): { ok: boolean; missing: string[] } {
  if (essentials.length === 0) return { ok: true, missing: [] };
  const blob = core
    .map((c) => `${c.name} ${c.original}`.toLowerCase())
    .join(" | ");
  const missing: string[] = [];
  for (const e of essentials) {
    const eLower = e.toLowerCase().trim();
    if (eLower.length < 3) continue;
    const parts = eLower.split(/\s+/).filter((w) => w.length >= 3);
    const hit =
      blob.includes(eLower) ||
      parts.every((w) => blob.includes(w)) ||
      parts.some((w) => w.length >= 4 && blob.includes(w));
    if (!hit) missing.push(e);
  }
  const ok =
    missing.length === 0 ||
    missing.length <= Math.max(1, Math.floor(essentials.length * 0.35));
  return { ok, missing };
}

/** PHASE C — ingredients + substitutions */
async function phaseCIngredients(
  openai: InstanceType<typeof import("openai").default>,
  profile: DishProfile,
  numberedIngredients: { id: number; line: string }[],
  fixHint?: string
): Promise<{
  core: StructuredIngredient[];
  optional: StructuredIngredient[];
  subs: RecipeSubstitutionEntry[];
} | null> {
  const system = `You are the ingredient decision engine for one recipe.

Using the DISH PROFILE and numbered CANDIDATE lines from sources:
- Choose core: required for an authentic dish (dish knowledge, NOT frequency).
- Choose optional: garnishes, nice-to-haves — must NOT duplicate essentials in core.
- substitutions: groups of interchangeable items (ingredient = main, options = alternates).
- Omit noise/wrong lines (do not list them in core/optional).

Return STRICT JSON:
{
  "core": [{ "name": string, "quantity": number | null, "unit": string }],
  "optional": [{ "name": string, "quantity": number | null, "unit": string }],
  "substitutions": [{ "ingredient": string, "options": string[], "note": string }]
}

Rules:
- Max 14 core, max 8 optional.
- No duplicate normalized ingredient names between core and optional (one line per ingredient).
- Every essential_ingredient from the profile must appear in core (merge duplicates into one line with best quantity).
- quantity null = unmeasured / to taste.`;

  const user = `DISH PROFILE:\n${JSON.stringify(profile, null, 2)}\n\nNUMBERED INGREDIENT CANDIDATES:\n${numberedIngredients.map((x) => `[${x.id}] ${x.line}`).join("\n")}${fixHint ? `\n\nFIX REQUIRED:\n${fixHint}` : ""}`;

  const p = await chatJson(openai, system, user);
  if (!p) return null;
  const parseIng = (arr: unknown): StructuredIngredient[] => {
    if (!Array.isArray(arr)) return [];
    const out: StructuredIngredient[] = [];
    for (const x of arr) {
      if (x && typeof x === "object") {
        const ing = ingredientFromJson(x as Record<string, unknown>);
        if (ing) out.push(ing);
      }
    }
    return out;
  };
  let core = parseIng(p.core).slice(0, 14);
  let optional = parseIng(p.optional).slice(0, 8);
  const subs = substitutionsFromPhaseC(p.substitutions);

  const merged = normalizeAndDedupeGroups({ core, optional });
  core = merged.core;
  optional = merged.optional;

  const seen = new Set<string>();
  const dedupeOpt: StructuredIngredient[] = [];
  for (const o of optional) {
    const k = normalizeIngredientName(o.name);
    if (seen.has(k) || core.some((c) => normalizeIngredientName(c.name) === k))
      continue;
    seen.add(k);
    dedupeOpt.push(o);
  }
  optional = dedupeOpt;

  return { core, optional, subs };
}

const STEP_STOP = new Set(
  `the and then into from with each side over heat until about minutes minute hour
  medium large small high low simmer boil bake fry roast grill stir whisk mix combine add remove
  place cover bowl pan pot oven stove skillet preheat reduce bring cool warm room drain rinse pat
  tablespoon teaspoons cup cups ounce pounds gram optional garnish serve transfer finally first
  lightly golden brown chopped diced minced sliced grated peeled soft done cooked through degrees`
    .split(/\s+/)
    .filter(Boolean)
);

function ingredientTokenSet(
  core: StructuredIngredient[],
  optional: StructuredIngredient[]
): Set<string> {
  const s = new Set<string>();
  for (const ing of [...core, ...optional]) {
    for (const w of `${ing.name} ${ing.original}`.toLowerCase().split(/\W+/)) {
      if (w.length >= 4) s.add(w);
    }
  }
  return s;
}

function validateStepsVsIngredients(
  steps: RecipeStep[],
  core: StructuredIngredient[],
  optional: StructuredIngredient[]
): string[] {
  const reasons: string[] = [];
  const tokens = ingredientTokenSet(core, optional);
  const text = steps.map((s) => s.instructions.toLowerCase()).join(" ");
  const words = text.match(/\b[a-z]{5,}\b/g) || [];
  let unknown = 0;
  for (const w of words) {
    if (STEP_STOP.has(w)) continue;
    if (tokens.has(w)) continue;
    if (w.endsWith("s") && tokens.has(w.slice(0, -1))) continue;
    unknown++;
  }
  if (unknown > 20) {
    reasons.push(
      "Steps mention many terms not reflected in ingredient names; rewrite using only listed ingredients."
    );
  }
  return reasons;
}

function stepBand(coreCount: number): { min: number; max: number; label: string } {
  if (coreCount <= 7) return { min: 5, max: 8, label: "simple" };
  if (coreCount <= 12) return { min: 7, max: 10, label: "medium" };
  return { min: 10, max: 14, label: "complex" };
}

/** PHASE D — steps + tips after ingredients locked */
async function phaseDAuthoring(
  openai: InstanceType<typeof import("openai").default>,
  profile: DishProfile,
  core: StructuredIngredient[],
  optional: StructuredIngredient[],
  stepCandidates: string[],
  tipCandidates: string[],
  band: { min: number; max: number; label: string },
  fixHint?: string
): Promise<{
  summary: string;
  steps: RecipeStep[];
  tips: string[];
  servings_base: number;
} | null> {
  const ingList = [
    ...core.map((c) => `${c.quantity ?? "—"} ${c.unit} ${c.name}`.trim()),
    ...optional.map((c) => `optional: ${c.quantity ?? "—"} ${c.unit} ${c.name}`.trim()),
  ].join("\n");

  const system = `You write the FINAL recipe steps. Ingredients are LOCKED — do not add new ones.

Return STRICT JSON:
{
  "summary": string,
  "servings": number,
  "steps": [
    {
      "title": string,
      "instructions": string,
      "time_minutes": number,
      "tools": string[],
      "warnings": string[]
    }
  ],
  "tips": string[]
}

Rules:
- summary: 1–2 sentences for the cook.
- steps: ${band.min} to ${band.max} steps for a ${band.label} recipe. Group flow: prep → cook/mix → assemble → chill/rest → serve.
- Do NOT split tiny actions into separate steps. Each step is substantial.
- instructions: concise, actionable, one paragraph max.
- Reference ONLY ingredients from the locked list (and water/salt/pepper/oil if already listed).
- time_minutes: realistic per step (0 if instant).
- tools: only when relevant (max 6 per step).
- warnings: inline cautions when useful (max 2 per step); else [].
- tips: max 6 short lines; omit fluff.
- servings: realistic yield (integer 1–24).`;

  const user = `DISH: ${profile.canonical_dish_name} (${profile.cuisine_style})

LOCKED INGREDIENTS:
${ingList}

STEP CANDIDATES (distill into ${band.min}–${band.max} logical steps):
${stepCandidates.slice(0, 80).map((s, i) => `${i + 1}. ${s}`).join("\n")}

TIP CANDIDATES (pick best, max 6):
${tipCandidates.slice(0, 40).map((s, i) => `${i + 1}. ${s}`).join("\n")}
${fixHint ? `\n\nCORRECTION:\n${fixHint}` : ""}`;

  const p = await chatJson(openai, system, user);
  if (!p) return null;
  const summary = String(p.summary ?? "").trim().slice(0, 800);
  let servings_base = 4;
  if (typeof p.servings === "number" && p.servings > 0 && p.servings < 500) {
    servings_base = Math.round(p.servings);
  }
  const stepsRaw = Array.isArray(p.steps) ? p.steps : [];
  const steps: RecipeStep[] = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const s = stepsRaw[i];
    if (s && typeof s === "object") {
      const st = stepFromAuthoring(s as Record<string, unknown>, steps.length);
      if (st) steps.push(st);
    }
  }
  const tips = Array.isArray(p.tips)
    ? p.tips.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
    : [];

  return { summary, steps, tips, servings_base };
}

function clampSteps(steps: RecipeStep[], max: number): RecipeStep[] {
  if (steps.length <= max) return steps;
  const merged: RecipeStep[] = [];
  const chunk = Math.ceil(steps.length / max);
  for (let i = 0; i < steps.length; i += chunk) {
    const group = steps.slice(i, i + chunk);
    if (group.length === 0) continue;
    const instructions = group.map((g) => g.instructions).join(" Then ");
    const title = group[0]!.title;
    const tools = Array.from(new Set(group.flatMap((g) => g.tools))).slice(
      0,
      8
    );
    const warnings = group.flatMap((g) => g.warnings ?? []).slice(0, 3);
    const maxMin = Math.max(
      ...group.map((g) => g.time_minutes ?? 0),
      0
    );
    merged.push({
      title,
      instructions,
      time: maxMin > 0 ? `${maxMin} min` : "As needed",
      tools,
      goal: warnings[0] || "",
      time_minutes: maxMin > 0 ? maxMin : undefined,
      warnings: warnings.length ? warnings : undefined,
    });
    if (merged.length >= max) break;
  }
  return merged.slice(0, max);
}

/**
 * Full 4-phase synthesis from source chunks (aligned with sources[] / raw_texts[]).
 */
export async function synthesizeRecipePhased(
  chunks: SourceChunk[],
  openaiApiKey: string,
  fallbackTitle: string
): Promise<{
  payload: SynthesisDbPayload;
  source_extractions: PerSourceExtraction[];
} | null> {
  if (!openaiApiKey?.trim() || chunks.length === 0) return null;
  const nonEmpty = chunks.filter((c) => c.text.trim().length > 0);
  if (nonEmpty.length === 0) return null;

  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: openaiApiKey });

  let extractions = await phaseAExtract(openai, nonEmpty);
  if (!extractions) return null;

  let allIng = extractions.flatMap((e) => e.ingredient_candidates);
  if (allIng.length === 0 && nonEmpty.some((c) => c.text.length > 80)) {
    const retryUser = nonEmpty
      .map(
        (c, i) =>
          `=== Source ${i + 1}: ${c.label} ===\n${c.text.slice(0, 12_000)}`
      )
      .join("\n\n");
    const fixP = await chatJson(
      openai,
      `Return STRICT JSON: { "sources": [ { "ingredient_candidates": string[], "step_candidates": [], "tip_candidates": [] } ] } with EXACTLY ${nonEmpty.length} entries. Each source MUST have ingredient_candidates (parse every ingredient from that block).`,
      retryUser
    );
    if (fixP && Array.isArray(fixP.sources)) {
      const arr = fixP.sources as unknown[];
      for (let i = 0; i < extractions.length && i < arr.length; i++) {
        const o = arr[i] as Record<string, unknown>;
        const ing = Array.isArray(o.ingredient_candidates)
          ? (o.ingredient_candidates as unknown[]).map((x) => String(x).trim()).filter(Boolean)
          : [];
        if (ing.length) extractions[i]!.ingredient_candidates = ing.slice(0, MAX_LIST);
      }
    }
    allIng = extractions.flatMap((e) => e.ingredient_candidates);
  }
  if (allIng.length === 0) {
    console.warn("[synthesis-phased] no ingredient candidates after Phase A");
    return null;
  }

  const profile =
    (await phaseBDishProfile(openai, allIng, fallbackTitle)) ?? {
      canonical_dish_name: fallbackTitle,
      cuisine_style: "—",
      essential_ingredients: [],
      optional_acceptable: [],
    };

  const numbered: { id: number; line: string }[] = [];
  let id = 0;
  for (const line of allIng) {
    const t = line.trim();
    if (t) numbered.push({ id: id++, line: t });
  }

  let phaseC = await phaseCIngredients(openai, profile, numbered);
  if (!phaseC || phaseC.core.length === 0) {
    const retry = await phaseCIngredients(
      openai,
      profile,
      numbered,
      "You must output non-empty core with quantities where possible. Merge duplicate lines."
    );
    if (retry) phaseC = retry;
  }
  if (!phaseC || phaseC.core.length === 0) return null;

  let { core, optional, subs } = phaseC;
  const cov = essentialCoverage(core, profile.essential_ingredients);
  if (!cov.ok && profile.essential_ingredients.length >= 2) {
    const retry = await phaseCIngredients(
      openai,
      profile,
      numbered,
      `Missing essentials in core: ${cov.missing.join(", ")}. Add them.`
    );
    if (retry && retry.core.length > 0) {
      core = retry.core;
      optional = retry.optional;
      subs = retry.subs;
    }
  }

  const optDup = optional.filter((o) =>
    profile.essential_ingredients.some(
      (e) =>
        normalizeIngredientName(e) === normalizeIngredientName(o.name) ||
        normalizeIngredientName(o.name).includes(normalizeIngredientName(e))
    )
  );
  if (optDup.length > 0) {
    const retry = await phaseCIngredients(
      openai,
      profile,
      numbered,
      `Move these from optional to core (they are essential): ${optDup.map((o) => o.name).join(", ")}`
    );
    if (retry) {
      core = retry.core;
      optional = retry.optional;
      subs = retry.subs;
    }
  }

  const stepCandidates = extractions.flatMap((e) => e.step_candidates);
  const tipCandidates = extractions.flatMap((e) => e.tip_candidates);
  const band = stepBand(core.length);

  let authored = await phaseDAuthoring(
    openai,
    profile,
    core,
    optional,
    stepCandidates,
    tipCandidates,
    band
  );
  if (!authored || authored.steps.length === 0) return null;

  let steps = authored.steps;
  let tips = authored.tips;
  let summary = authored.summary;
  let servings_base = authored.servings_base;

  let v = validateStepsVsIngredients(steps, core, optional);
  if (v.length > 0 || steps.length > band.max || steps.length < Math.min(3, band.min)) {
    const retryD = await phaseDAuthoring(
      openai,
      profile,
      core,
      optional,
      stepCandidates,
      tipCandidates,
      band,
      [
        ...v,
        steps.length > band.max
          ? `Use at most ${band.max} steps.`
          : steps.length < band.min
            ? `Use at least ${band.min} logical steps.`
            : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
    if (retryD && retryD.steps.length > 0) {
      steps = retryD.steps;
      tips = retryD.tips.length ? retryD.tips : tips;
      summary = retryD.summary || summary;
      servings_base = retryD.servings_base || servings_base;
    }
  }

  if (steps.length > band.max) steps = clampSteps(steps, band.max);
  if (steps.length < band.min && steps.length > 0) {
    /* keep short recipes if model returned fewer meaningful steps */
  }

  v = validateStepsVsIngredients(steps, core, optional);
  if (v.length > 0) {
    console.warn("[synthesis-phased] step validation soft fail:", v.join(" | "));
  }

  const title = profile.canonical_dish_name || fallbackTitle;

  const payload: SynthesisDbPayload = {
    title,
    description: summary,
    ingredients: { core, optional },
    steps,
    tips,
    substitutionsDetailed: subs,
    mistakes: [],
    techniques: [],
    estimated_time: "—",
    servings: servingsDisplayLabel(Math.max(1, servings_base)),
    servings_base: Math.max(1, servings_base),
  };

  return { payload, source_extractions: extractions };
}

/** Build chunks from merged raw_texts + sources */
export function chunksFromHistory(
  sources: string[],
  raw_texts: string[]
): SourceChunk[] {
  const n = Math.max(sources.length, raw_texts.length);
  const out: SourceChunk[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      label: String(sources[i] ?? `Source ${i + 1}`),
      text: String(raw_texts[i] ?? ""),
    });
  }
  return out.filter((c) => c.text.trim().length > 0);
}

/** Versions path: synthetic chunks from structured recipes */
export function chunksFromVersions(
  sources: ExtractedRecipeWithConfidence[]
): SourceChunk[] {
  return sources.map((s, i) => {
    const ing = s.ingredients
      .map((x) => x.original || [x.quantity, x.unit, x.name].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("\n");
    const st = s.steps.map((t, j) => `${j + 1}. ${t}`).join("\n");
    return {
      label: s.title || `Version ${i + 1}`,
      text: `INGREDIENTS:\n${ing || "(none)"}\n\nSTEPS:\n${st || "(none)"}`,
    };
  });
}
