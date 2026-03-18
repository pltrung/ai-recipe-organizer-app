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
import {
  compileDynamicPlaybook,
  playbookForPhaseC,
  playbookForPhaseD,
} from "./dynamicPlaybook";
import {
  type SourceConfidence,
  confidenceFromPlatformRaw,
} from "./sourceSynthesisConfidence";
import type { RecipeQualityMeta } from "./types";

export type SourceChunk = {
  label: string;
  text: string;
  /** Default medium if omitted */
  confidence?: SourceConfidence;
};

export type SynthesisStyle =
  | "authentic"
  | "easier_at_home"
  | "lighter"
  | "rich_indulgent";

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
  const system = `You are a culinary expert. Given raw ingredient mentions from one or more sources about the SAME dish, infer identity and essentials.

Return STRICT JSON:
{
  "canonical_dish_name": string,
  "cuisine_style": string,
  "essential_ingredients": string[],
  "optional_acceptable": string[]
}

essential_ingredients: defining items. optional_acceptable: add-ons.
cuisine_style: e.g. Vietnamese, Italian, Japanese, Thai, regional Chinese, etc.
Use dish knowledge — not vote counting.`;

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

const STYLE_GUIDE: Record<SynthesisStyle, string> = {
  authentic: "Traditional ingredients and methods.",
  easier_at_home: "Supermarket staples, forgiving techniques.",
  lighter: "Lighter fats/sugar where possible; keep identity.",
  rich_indulgent: "Full-flavor, generous, indulgent.",
};

async function phaseCIngredients(
  openai: InstanceType<typeof import("openai").default>,
  profile: DishProfile,
  numbered: {
    id: number;
    line: string;
    sourceIndex: number;
    sourceConf: SourceConfidence;
  }[],
  synthesisStyle: SynthesisStyle,
  playbookC: string,
  fixHint?: string
): Promise<{
  core: StructuredIngredient[];
  optional: StructuredIngredient[];
  subs: RecipeSubstitutionEntry[];
  core_rationale: { name: string; why: string }[];
  variant_notes: string[];
} | null> {
  const system = `Ingredient decision engine. Candidates tagged [id] (S# CONFIDENCE) text.
CONFIDENCE: high=structured; medium_high=long text; medium=image; low=reel/weak.
RULE: Items ONLY from low-confidence sources are NOT core unless dish-essential OR corroborated by medium+ sources.

STYLE: ${synthesisStyle} — ${STYLE_GUIDE[synthesisStyle]}

Return STRICT JSON:
{
  "core": [{ "name": string, "quantity": number | null, "unit": string }],
  "optional": [...],
  "substitutions": [{ "ingredient": string, "options": string[], "note": string }],
  "core_rationale": [{ "name": string, "why": string }],
  "variant_notes": string[]
}
variant_notes: 0–3 lines if sources diverge meaningfully; else [].
Max 14 core, 8 optional. Essentials from profile in core.`;

  const lines = numbered.map(
    (x) => `[${x.id}] (S${x.sourceIndex} ${x.sourceConf}) ${x.line}`
  );
  const user = `${playbookC}\n\n---\n\nPROFILE:\n${JSON.stringify(profile, null, 2)}\n\n${lines.join("\n")}${fixHint ? `\n\nFIX:\n${fixHint}` : ""}`;

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
  const core_rationale: { name: string; why: string }[] = Array.isArray(
    p.core_rationale
  )
    ? (p.core_rationale as unknown[])
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const o = x as Record<string, unknown>;
          const name = String(o.name ?? "").trim();
          const why = String(o.why ?? "").trim();
          return name && why ? { name, why: why.slice(0, 220) } : null;
        })
        .filter(Boolean) as { name: string; why: string }[]
    : [];
  const variant_notes = Array.isArray(p.variant_notes)
    ? p.variant_notes
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];

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

  return { core, optional, subs, core_rationale, variant_notes };
}

async function phaseIngredientRoles(
  openai: InstanceType<typeof import("openai").default>,
  core: StructuredIngredient[],
  optional: StructuredIngredient[]
): Promise<{ name: string; role: string }[]> {
  const list = [...core, ...optional].map((i) => i.name).filter(Boolean);
  if (!list.length) return [];
  const p = await chatJson(
    openai,
    `Tag each ingredient with ONE role: structure | flavor_base | richness | garnish | aroma | optional_enhancement
Return STRICT JSON: { "roles": [{ "name": string, "role": string }] }`,
    list.join("\n")
  );
  if (!p || !Array.isArray(p.roles)) return [];
  return (p.roles as unknown[])
    .map((x) => {
      if (!x || typeof x !== "object") return null;
      const o = x as Record<string, unknown>;
      const name = String(o.name ?? "").trim();
      const role = String(o.role ?? "").trim();
      return name ? { name, role } : null;
    })
    .filter(Boolean) as { name: string; role: string }[];
}

function missingCoreInSteps(
  core: StructuredIngredient[],
  steps: RecipeStep[]
): string[] {
  const blob = steps
    .map((s) => `${s.title} ${s.instructions}`.toLowerCase())
    .join(" ");
  const miss: string[] = [];
  for (const c of core) {
    const n = c.name.toLowerCase().trim();
    if (n.length < 2) continue;
    const toks = n.split(/\s+/).filter((w) => w.replace(/\W/g, "").length >= 3);
    const hit =
      blob.includes(n) ||
      toks.some((t) => t.length >= 4 && blob.includes(t.replace(/\W/g, "")));
    if (!hit) miss.push(c.name);
  }
  return miss;
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

async function phaseDAuthoring(
  openai: InstanceType<typeof import("openai").default>,
  profile: DishProfile,
  playbookD: string,
  dishFamilyLabel: string,
  core: StructuredIngredient[],
  optional: StructuredIngredient[],
  rolesLines: string,
  stepCandidates: string[],
  tipCandidates: string[],
  synthesisStyle: SynthesisStyle,
  band: { min: number; max: number },
  fixHint?: string
): Promise<{
  summary: string;
  steps: RecipeStep[];
  tips: string[];
  servings_base: number;
  critical_tips: string[];
  avoid_mistakes: string[];
} | null> {
  const ingList = [
    ...core.map((c) => `${c.quantity ?? "—"} ${c.unit} ${c.name}`.trim()),
    ...optional.map((c) => `optional: ${c.quantity ?? "—"} ${c.unit} ${c.name}`.trim()),
  ].join("\n");
  const coreNames = core.map((c) => c.name).join(", ");

  const system = `You write ONE clean, chef-curated recipe — not a merge dump.

${playbookD}

Return STRICT JSON:
{
  "summary": string,
  "servings": number,
  "steps": [{ "title": string, "instructions": string, "time_minutes": number, "tools": string[], "warnings": string[] }],
  "tips": string[],
  "critical_tips": string[],
  "avoid_mistakes": string[]
}

RULES:
- Steps: ${band.min}–${band.max} substantial steps. Follow EXPECTED FLOW order above.
- EVERY core ingredient MUST be named in at least one step's instructions: cores are [${coreNames}].
- STYLE ${synthesisStyle}: ${STYLE_GUIDE[synthesisStyle]}
- warnings: step-level cautions (max 2/step).
- critical_tips: max 3 must-know pro tips (different from generic tips).
- avoid_mistakes: max 3 common failures to avoid.
- tips: max 4 helpful lines (non-critical).
- Only listed ingredients + water/salt/oil if in list.`;

  const user = `DISH: ${profile.canonical_dish_name} (${profile.cuisine_style}) [family: ${dishFamilyLabel}]

INGREDIENT ROLES:
${rolesLines || "(none)"}

INGREDIENTS:
${ingList}

STEPS FROM SOURCES:
${stepCandidates.slice(0, 80).map((s, i) => `${i + 1}. ${s}`).join("\n")}

TIPS FROM SOURCES:
${tipCandidates.slice(0, 40).map((s, i) => `${i + 1}. ${s}`).join("\n")}
${fixHint ? `\n\nFIX:\n${fixHint}` : ""}`;

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
    ? p.tips.map((t) => String(t).trim()).filter(Boolean).slice(0, 4)
    : [];
  const critical_tips = Array.isArray(p.critical_tips)
    ? p.critical_tips.map((t) => String(t).trim()).filter(Boolean).slice(0, 3)
    : [];
  const avoid_mistakes = Array.isArray(p.avoid_mistakes)
    ? p.avoid_mistakes.map((t) => String(t).trim()).filter(Boolean).slice(0, 3)
    : [];

  return {
    summary,
    steps,
    tips,
    servings_base,
    critical_tips,
    avoid_mistakes,
  };
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
  fallbackTitle: string,
  opts?: { synthesisStyle?: SynthesisStyle }
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

  const stepCandidatesAll = extractions.flatMap((e) => e.step_candidates);
  const tipCandidatesAll = extractions.flatMap((e) => e.tip_candidates);
  const confidenceSummary = nonEmpty
    .map((c) => `${c.label}: ${c.confidence ?? "medium"}`)
    .join(" | ");

  const dynamicPb = await compileDynamicPlaybook(openaiApiKey, {
    dishName: profile.canonical_dish_name,
    cuisine: profile.cuisine_style,
    ingredientCandidates: allIng,
    stepCandidates: stepCandidatesAll,
    tipCandidates: tipCandidatesAll,
    confidenceSummary,
  });
  const playbookC = playbookForPhaseC(dynamicPb);
  const playbookD = playbookForPhaseD(dynamicPb);
  const band = {
    min: Math.max(3, dynamicPb.stepMin),
    max: Math.min(16, dynamicPb.stepMax),
  };

  console.log(
    `[synthesis-phased] dynamic_playbook family=${dynamicPb.dish_family} anchors_ing=${dynamicPb.signature_ingredients.length} anchors_tech=${dynamicPb.signature_techniques.length}`
  );

  const style: SynthesisStyle =
    opts?.synthesisStyle &&
    ["authentic", "easier_at_home", "lighter", "rich_indulgent"].includes(
      opts.synthesisStyle
    )
      ? opts.synthesisStyle
      : "authentic";

  const numbered: {
    id: number;
    line: string;
    sourceIndex: number;
    sourceConf: SourceConfidence;
  }[] = [];
  let nid = 0;
  for (let si = 0; si < extractions.length; si++) {
    const conf: SourceConfidence =
      nonEmpty[si]?.confidence ?? "medium";
    for (const line of extractions[si]!.ingredient_candidates) {
      const t = line.trim();
      if (t) numbered.push({ id: nid++, line: t, sourceIndex: si, sourceConf: conf });
    }
  }

  let phaseC = await phaseCIngredients(openai, profile, numbered, style, playbookC);
  if (!phaseC || phaseC.core.length === 0) {
    const retry = await phaseCIngredients(
      openai,
      profile,
      numbered,
      style,
      playbookC,
      "Non-empty core required with quantities where possible."
    );
    if (retry) phaseC = retry;
  }
  if (!phaseC || phaseC.core.length === 0) return null;

  let {
    core,
    optional,
    subs,
    core_rationale,
    variant_notes,
  } = phaseC;
  const cov = essentialCoverage(core, profile.essential_ingredients);
  if (!cov.ok && profile.essential_ingredients.length >= 2) {
    const retry = await phaseCIngredients(
      openai,
      profile,
      numbered,
      style,
      playbookC,
      `Missing essentials in core: ${cov.missing.join(", ")}.`
    );
    if (retry && retry.core.length > 0) {
      core = retry.core;
      optional = retry.optional;
      subs = retry.subs;
      core_rationale = retry.core_rationale;
      variant_notes = retry.variant_notes;
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
      style,
      playbookC,
      `Move to core: ${optDup.map((o) => o.name).join(", ")}`
    );
    if (retry) {
      core = retry.core;
      optional = retry.optional;
      subs = retry.subs;
      core_rationale = retry.core_rationale;
      variant_notes = retry.variant_notes;
    }
  }

  const roleRows = await phaseIngredientRoles(openai, core, optional);
  const rolesLines = roleRows.map((r) => `${r.name}: ${r.role}`).join("\n");

  let authored = await phaseDAuthoring(
    openai,
    profile,
    playbookD,
    dynamicPb.dish_family,
    core,
    optional,
    rolesLines,
    stepCandidatesAll,
    tipCandidatesAll,
    style,
    band
  );
  if (!authored || authored.steps.length === 0) return null;

  let steps = authored.steps;
  let tips = authored.tips;
  let summary = authored.summary;
  let servings_base = authored.servings_base;
  let critical_tips = authored.critical_tips;
  let avoid_mistakes = authored.avoid_mistakes;

  let miss = missingCoreInSteps(core, steps);
  let v = validateStepsVsIngredients(steps, core, optional);
  if (
    miss.length > 0 ||
    v.length > 0 ||
    steps.length > band.max ||
    steps.length < Math.min(3, band.min)
  ) {
    const retryD = await phaseDAuthoring(
      openai,
      profile,
      playbookD,
      dynamicPb.dish_family,
      core,
      optional,
      rolesLines,
      stepCandidatesAll,
      tipCandidatesAll,
      style,
      band,
      [
        miss.length ? `Use these core items in steps: ${miss.join(", ")}` : "",
        ...v,
        steps.length > band.max ? `Max ${band.max} steps.` : "",
        steps.length < band.min ? `At least ${band.min} steps.` : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
    if (retryD && retryD.steps.length > 0) {
      steps = retryD.steps;
      tips = retryD.tips.length ? retryD.tips : tips;
      summary = retryD.summary || summary;
      servings_base = retryD.servings_base || servings_base;
      critical_tips = retryD.critical_tips.length
        ? retryD.critical_tips
        : critical_tips;
      avoid_mistakes = retryD.avoid_mistakes.length
        ? retryD.avoid_mistakes
        : avoid_mistakes;
    }
  }

  if (steps.length > band.max) steps = clampSteps(steps, band.max);

  miss = missingCoreInSteps(core, steps);
  if (miss.length > 0) {
    console.warn("[synthesis-phased] core not all in steps:", miss.join(", "));
  }

  const title = profile.canonical_dish_name || fallbackTitle;
  const mergedTips = [
    ...critical_tips,
    ...variant_notes,
    ...tips,
  ].filter(Boolean).slice(0, 12);

  const recipe_quality: RecipeQualityMeta = {
    dish_taxonomy: dynamicPb.dish_family,
    synthesis_style: style,
    variant_notes,
    core_rationale: core_rationale.slice(0, 16),
    critical_tips,
    avoid_mistakes,
    ingredient_roles: roleRows,
  };

  const payload: SynthesisDbPayload = {
    title,
    description: summary,
    ingredients: { core, optional },
    steps,
    tips: mergedTips,
    substitutionsDetailed: subs,
    mistakes: avoid_mistakes,
    techniques: [],
    estimated_time: "—",
    servings: servingsDisplayLabel(Math.max(1, servings_base)),
    servings_base: Math.max(1, servings_base),
    recipe_quality,
  };

  return { payload, source_extractions: extractions };
}

/** Build chunks from merged raw_texts + sources */
export function chunksFromHistory(
  sources: string[],
  raw_texts: string[],
  confidences?: SourceConfidence[],
  platforms?: string[]
): SourceChunk[] {
  const n = Math.max(sources.length, raw_texts.length);
  const out: SourceChunk[] = [];
  for (let i = 0; i < n; i++) {
    const text = String(raw_texts[i] ?? "");
    const conf =
      confidences?.[i] ??
      (platforms?.[i]
        ? confidenceFromPlatformRaw(platforms[i]!, text.length)
        : undefined);
    out.push({
      label: String(sources[i] ?? `Source ${i + 1}`),
      text,
      confidence: conf ?? "medium",
    });
  }
  return out.filter((c) => c.text.trim().length > 0);
}

function versionToSourceConf(c: string): SourceConfidence {
  if (c === "high") return "high";
  if (c === "low") return "low";
  return "medium_high";
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
      confidence: versionToSourceConf(s.confidence),
    };
  });
}
