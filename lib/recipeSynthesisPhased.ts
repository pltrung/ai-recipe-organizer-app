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
  familyMandatoryHintsDetailed,
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

function essentialHitInBlob(blob: string, essential: string): boolean {
  const eLower = essential.toLowerCase().trim();
  if (eLower.length < 2) return false;
  const ne = normalizeIngredientName(essential).toLowerCase();
  if (ne.length >= 3 && blob.includes(ne)) return true;
  const parts = eLower.split(/\s+/).filter((w) => w.length >= 3);
  return (
    blob.includes(eLower) ||
    parts.every((w) => blob.includes(w)) ||
    parts.some((w) => w.length >= 4 && blob.includes(w))
  );
}

/** Strict: every listed essential must appear in core (by name match). */
function strictEssentialsMissing(
  core: StructuredIngredient[],
  essentials: string[]
): string[] {
  if (essentials.length === 0) return [];
  const blob = core.map((c) => `${c.name} ${c.original}`).join(" | ").toLowerCase();
  const missing: string[] = [];
  for (const e of essentials) {
    if (e.trim().length < 2) continue;
    if (!essentialHitInBlob(blob, e)) missing.push(e);
  }
  return missing;
}

function duplicateNormalizedInCore(core: StructuredIngredient[]): boolean {
  const seen = new Set<string>();
  for (const c of core) {
    const k = normalizeIngredientName(c.name);
    if (!k) continue;
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

function optionalHasEssentialOverlap(
  optional: StructuredIngredient[],
  essentials: string[]
): string[] {
  const bad: string[] = [];
  for (const o of optional) {
    const on = normalizeIngredientName(o.name);
    for (const e of essentials) {
      if (essentialHitInBlob(`${o.name} ${o.original}`.toLowerCase(), e)) {
        bad.push(o.name);
        break;
      }
      if (
        on.length >= 3 &&
        normalizeIngredientName(e) === on
      ) {
        bad.push(o.name);
        break;
      }
    }
  }
  return bad;
}

function hasConfidentSource(
  numbered: { sourceConf: SourceConfidence }[]
): boolean {
  return numbered.some((n) => n.sourceConf !== "low");
}

/** Core items only mentioned by low-confidence sources — disallow unless essential/anchor. */
function coreFromLowOnlySources(
  core: StructuredIngredient[],
  numbered: {
    line: string;
    sourceConf: SourceConfidence;
  }[],
  essentials: string[],
  signatureIngredients: string[]
): string[] {
  if (!hasConfidentSource(numbered)) return [];
  const sigNorm = signatureIngredients.map((s) => normalizeIngredientName(s).toLowerCase()).filter(Boolean);
    const violations: string[] = [];
    for (const c of core) {
      const cn = normalizeIngredientName(c.name).toLowerCase();
      let isEss = false;
      for (const e of essentials) {
        if (essentialHitInBlob(`${c.name} ${c.original || ""}`.toLowerCase(), e)) {
          isEss = true;
          break;
        }
      }
      if (isEss) continue;
      if (sigNorm.some((s) => cn.includes(s) || s.includes(cn))) continue;
      const fromConfident = numbered.filter(
        (n) =>
          n.sourceConf === "high" ||
          n.sourceConf === "medium_high" ||
          n.sourceConf === "medium"
      );
      const blob = fromConfident.map((n) => n.line.toLowerCase()).join(" | ");
      if (essentialHitInBlob(blob, c.name) || essentialHitInBlob(blob, cn))
        continue;
      if (cn.length >= 4 && blob.includes(cn)) continue;
      violations.push(c.name);
    }
  return violations;
}

function filterSubstitutionsQuality(
  subs: RecipeSubstitutionEntry[],
  core: StructuredIngredient[],
  optional: StructuredIngredient[]
): RecipeSubstitutionEntry[] {
  const out: RecipeSubstitutionEntry[] = [];
  const seenIng = new Set<string>();
  for (const s of subs) {
    const ing = normalizeIngredientName(s.ingredient).toLowerCase();
    if (!ing || seenIng.has(ing)) continue;
    seenIng.add(ing);
    const opts = (s.options ?? []).filter((o) => {
      const on = normalizeIngredientName(o).toLowerCase();
      if (!on || on === ing) return false;
      const ingToks = new Set(ing.split(/\s+/).filter((t) => t.length > 3));
      const oToks = new Set(on.split(/\s+/).filter((t) => t.length > 3));
      let overlap = 0;
      ingToks.forEach((t) => {
        if (oToks.has(t)) overlap++;
      });
      if (overlap === 0 && ingToks.size > 0 && oToks.size > 0) {
        if (!s.note?.trim()) return false;
      }
      return true;
    });
    if (opts.length === 0) continue;
    out.push({ ...s, options: opts.slice(0, 4) });
  }
  return out.slice(0, 12);
}

function mergedStepBand(
  coreCount: number,
  famMin: number,
  famMax: number
): { min: number; max: number } {
  let min = 5;
  let max = 7;
  if (coreCount > 7) {
    min = 6;
    max = 9;
  }
  if (coreCount > 12) {
    min = 8;
    max = 12;
  }
  return {
    min: Math.min(12, Math.max(3, Math.max(min, famMin))),
    max: Math.min(12, Math.min(max, famMax)),
  };
}

function dedupeStrings(arr: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of arr) {
    const k = x.toLowerCase().trim().slice(0, 200);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x.trim());
    if (out.length >= max) break;
  }
  return out;
}

function injectFamilyMandatorySteps(
  steps: RecipeStep[],
  family: string
): { steps: RecipeStep[]; injected: boolean } {
  const fullText = steps
    .map((s) => `${s.title} ${s.instructions}`.toLowerCase())
    .join(" ");
  let injected = false;
  const f = family.toLowerCase();
  const out = [...steps];

  if (f === "baked_cake" && !/preheat|oven to \d|heat oven/.test(fullText)) {
    out.unshift({
      title: "Preheat oven",
      instructions:
        "Preheat the oven to the temperature your bake calls for (often 325–375°F / 165–190°C).",
      time: "15 min",
      tools: ["oven"],
      goal: "",
      time_minutes: 15,
    });
    injected = true;
  }

  if (f === "pizza_flatbread") {
    const t = out.map((s) => `${s.title} ${s.instructions}`.toLowerCase()).join(" ");
    if (!/rest|proof|rise|ferment/.test(t) && out.length >= 1) {
      out.splice(1, 0, {
        title: "Rest the dough",
        instructions:
          "Cover and let the dough rest until easy to stretch (30 min–2 hr at room temp, or cold ferment longer).",
        time: "30+ min",
        tools: [],
        goal: "",
        time_minutes: 30,
      });
      injected = true;
    }
    const t2 = out.map((s) => `${s.title} ${s.instructions}`.toLowerCase()).join(" ");
    if (!/preheat|heat (the )?oven|stone|steel.*hot/.test(t2)) {
      const bakeIdx = out.findIndex((s) =>
        /bake|oven|pizza|stone|steel/i.test(`${s.title} ${s.instructions}`)
      );
      const pre = {
        title: "Preheat for high-heat bake",
        instructions:
          "Preheat oven with baking steel or sheet pan as hot as practical (500°F+ / 260°C) for 30–45 minutes before baking.",
        time: "30 min",
        tools: ["oven", "baking steel or sheet"],
        goal: "",
        time_minutes: 30,
      } as RecipeStep;
      if (bakeIdx >= 0) out.splice(bakeIdx, 0, pre);
      else out.push(pre);
      injected = true;
    }
  }

  if (
    f === "layered_chilled_dessert" &&
    !/chill|refrigerat|fridge|until set|overnight/.test(fullText)
  ) {
    const idx = Math.max(0, out.length - 2);
    out.splice(idx, 0, {
      title: "Chill until set",
      instructions:
        "Refrigerate until firm (often 4+ hours or overnight). Cover loosely if needed.",
      time: "4+ hours",
      tools: [],
      goal: "",
      time_minutes: 240,
    });
    injected = true;
  }

  if (
    (f === "noodle_soup" || f === "rice_plate") &&
    !/bowl|ladle|assemble|divide|portion/.test(fullText)
  ) {
    if (out.length > 0) {
      out.push({
        title: "Assemble and serve",
        instructions:
          "Portion noodles or rice into bowls, add toppings, then ladle broth or sauce. Serve hot.",
        time: "5 min",
        tools: ["ladle", "bowls"],
        goal: "",
        time_minutes: 5,
      });
      injected = true;
    }
  }

  return { steps: out.slice(0, 14), injected };
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
  rejected_or_noise: string[];
} | null> {
  const system = `Strict ingredient JUDGE (not a merger). Candidates: [id] (S# CONFIDENCE) line.

CONFIDENCE — material weight:
- high: dominant for core when aligned with dish + playbook.
- medium_high / medium: strong support for core.
- low: OPTIONAL, substitutions, variant_notes, tips ONLY — never core unless it matches an essential_ingredients item OR a playbook signature identity ingredient (same dish-defining role).

CLUSTER before you decide: one core slot per culinary concept (espresso ≈ strong coffee → coffee; heavy whipping cream ≈ heavy cream; nước mắm ≈ fish sauce; ladyfingers ≈ savoiardi).

ESSENTIALS: profile.essential_ingredients MUST appear in core (by name or accepted synonym). Do NOT leave essentials in optional unless you give a substitution that replaces that role.

SUBSTITUTIONS: role-aligned only (e.g. coffee↔espresso). Unrelated swaps require a note explaining intentional style change. Omit shallow or wrong subs.

rejected_or_noise: every line you reject (weak DOM, off-dish, duplicate cluster loser) — short phrases.

STYLE: ${synthesisStyle} — ${STYLE_GUIDE[synthesisStyle]}

Return STRICT JSON:
{
  "core": [{ "name": string, "quantity": number | null, "unit": string }],
  "optional": [...],
  "substitutions": [{ "ingredient": string, "options": string[], "note": string }],
  "core_rationale": [{ "name": string, "why": string }],
  "variant_notes": string[],
  "rejected_or_noise": string[]
}
Max 12 core, 10 optional. variant_notes max 3.`;

  const lines = numbered.map(
    (x) => `[${x.id}] (S${x.sourceIndex} ${x.sourceConf}) ${x.line}`
  );
  const user = `${playbookC}\n\n---\n\nPROFILE:\n${JSON.stringify(profile, null, 2)}\n\nCANDIDATES:\n${lines.join("\n")}${fixHint ? `\n\nCORRECTION REQUIRED:\n${fixHint}` : ""}`;

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
  let core = parseIng(p.core).slice(0, 12);
  let optional = parseIng(p.optional).slice(0, 10);
  let subs = substitutionsFromPhaseC(p.substitutions);
  const core_rationale: { name: string; why: string }[] = Array.isArray(
    p.core_rationale
  )
    ? (p.core_rationale as unknown[])
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const o = x as Record<string, unknown>;
          const name = String(o.name ?? "").trim();
          const why = String(o.why ?? "").trim();
          return name && why ? { name, why: why.slice(0, 180) } : null;
        })
        .filter(Boolean) as { name: string; why: string }[]
    : [];
  const variant_notes = Array.isArray(p.variant_notes)
    ? p.variant_notes
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  const rejected_or_noise = Array.isArray(p.rejected_or_noise)
    ? (p.rejected_or_noise as unknown[])
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 40)
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
  subs = filterSubstitutionsQuality(subs, core, optional);

  return { core, optional, subs, core_rationale, variant_notes, rejected_or_noise };
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
  dCtx: {
    subsLines: string;
    variantNotes: string[];
    tipIdeas: string[];
    failurePoints: string[];
  },
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
  const familyMandatory = familyMandatoryHintsDetailed(dishFamilyLabel);

  const system = `Chef editor: one coherent recipe — NOT a summary of sources. Imperative, cookable.

${playbookD}

FAMILY CHECKLIST: ${familyMandatory}

Return STRICT JSON:
{
  "summary": string (≤2 sentences),
  "servings": number,
  "steps": [{ "title": string, "instructions": string, "time_minutes": number, "tools": string[], "warnings": string[] }],
  "tips": string[],
  "critical_tips": string[],
  "avoid_mistakes": string[]
}

RULES:
- Exactly ${band.min}–${band.max} steps. Map 1:1 to EXPECTED_FLOW order (combine adjacent beats in one step if needed).
- Title: short action (e.g. "Make the broth"). Instructions: max 3 tight sentences. No paragraph dumps.
- Use EVERY core in steps: [${coreNames}]. Optional only where relevant.
- warnings: max 1–2 per step, only for real failure risk.
- critical_tips: max 6, high-value only.
- avoid_mistakes: max 5, from playbook failure points where applicable.
- tips: max 3 brief extras.
- STYLE ${synthesisStyle}: ${STYLE_GUIDE[synthesisStyle]}
- Ingredients: only listed + water/salt if implied.`;

  const tipBlock =
    dCtx.tipIdeas.length > 0
      ? dCtx.tipIdeas.map((t, i) => `${i + 1}. ${t}`).join("\n")
      : "(none)";
  const failBlock = dCtx.failurePoints.length
    ? dCtx.failurePoints.join("\n- ")
    : "(none)";

  const user = `DISH: ${profile.canonical_dish_name} (${profile.cuisine_style}) | family: ${dishFamilyLabel}

ROLES:
${rolesLines || "(none)"}

CORE + OPTIONAL:
${ingList}

SUBSTITUTIONS (respect when cook swaps):
${dCtx.subsLines || "(none)"}

VARIANT NOTES:
${dCtx.variantNotes.length ? dCtx.variantNotes.map((v, i) => `${i + 1}. ${v}`).join("\n") : "(none)"}

TIP IDEAS — paraphrase into critical_tips / avoid_mistakes / tips; do NOT copy verbatim:
${tipBlock}

PLAYBOOK FAILURE POINTS — cover in avoid_mistakes or sparse warnings:
- ${failBlock}
${fixHint ? `\n\nEDITOR FIX:\n${fixHint}` : ""}`;

  const p = await chatJson(openai, system, user);
  if (!p) return null;
  const summary = String(p.summary ?? "").trim().slice(0, 400);
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
      if (st) {
        if (st.instructions.length > 520) {
          st.instructions = st.instructions.slice(0, 517).trim() + "…";
        }
        steps.push(st);
      }
    }
  }
  const tips = dedupeStrings(
    Array.isArray(p.tips)
      ? p.tips.map((t) => String(t).trim()).filter(Boolean)
      : [],
    3
  );
  const critical_tips = dedupeStrings(
    Array.isArray(p.critical_tips)
      ? p.critical_tips.map((t) => String(t).trim()).filter(Boolean)
      : [],
    6
  );
  const avoid_mistakes = dedupeStrings(
    Array.isArray(p.avoid_mistakes)
      ? p.avoid_mistakes.map((t) => String(t).trim()).filter(Boolean)
      : [],
    5
  );

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

  console.log(
    `[synthesis-phased:B] dish=${profile.canonical_dish_name.slice(0, 80)} cuisine=${profile.cuisine_style} essentials=[${profile.essential_ingredients.slice(0, 8).join("; ")}]`
  );

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

  console.log(
    `[synthesis-phased:playbook] family=${dynamicPb.dish_family} cuisine_lens=${dynamicPb.cuisine} anchors_ing=[${dynamicPb.signature_ingredients.join(", ")}] anchors_tech=[${dynamicPb.signature_techniques.join(", ")}] conf=${confidenceSummary.slice(0, 120)}`
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

  function phaseCFixReason(
    core: StructuredIngredient[],
    optional: StructuredIngredient[],
    numberedLocal: typeof numbered
  ): string | null {
    const parts: string[] = [];
    const miss = strictEssentialsMissing(core, profile.essential_ingredients);
    if (miss.length) {
      parts.push(
        `CORE must include every essential: ${miss.join("; ")}. Add quantities where possible.`
      );
    }
    const optEss = optionalHasEssentialOverlap(
      optional,
      profile.essential_ingredients
    );
    if (optEss.length) {
      parts.push(
        `These are dish-defining — move from optional to CORE: ${optEss.join("; ")}.`
      );
    }
    if (duplicateNormalizedInCore(core)) {
      parts.push(
        "One core line per ingredient concept only (dedupe synonyms)."
      );
    }
    const lowOnly = coreFromLowOnlySources(
      core,
      numberedLocal,
      profile.essential_ingredients,
      dynamicPb.signature_ingredients
    );
    if (lowOnly.length) {
      parts.push(
        `Demote to optional or drop (only weak-source, not essential/signature): ${lowOnly.join("; ")}.`
      );
    }
    return parts.length ? parts.join(" ") : null;
  }

  let phaseC: Awaited<ReturnType<typeof phaseCIngredients>> = null;
  let cFix: string | undefined;
  for (let cAttempt = 0; cAttempt < 4; cAttempt++) {
    const r = await phaseCIngredients(
      openai,
      profile,
      numbered,
      style,
      playbookC,
      cFix
    );
    if (!r || r.core.length === 0) {
      console.log(
        `[synthesis-phased:C] retry attempt=${cAttempt + 1} reason=empty_core`
      );
      cFix =
        "Non-empty core with all essentials and playbook signature ingredients in core.";
      continue;
    }
    phaseC = r;
    const reason = phaseCFixReason(r.core, r.optional, numbered);
    if (!reason) {
      if (cAttempt > 0) {
        console.log(
          `[synthesis-phased:C] settled after ${cAttempt + 1} attempts`
        );
      }
      break;
    }
    console.log(
      `[synthesis-phased:C] retry attempt=${cAttempt + 1} reason=${reason.slice(0, 220)}`
    );
    if (cAttempt === 3) break;
    cFix = reason;
  }
  if (!phaseC || phaseC.core.length === 0) return null;

  let {
    core,
    optional,
    subs,
    core_rationale,
    variant_notes,
    rejected_or_noise,
  } = phaseC;

  const missEss = strictEssentialsMissing(core, profile.essential_ingredients);
  if (missEss.length) {
    console.log(
      `[synthesis-phased:C] essentials_still_missing_after_retries=[${missEss.join("; ")}] (model best-effort)`
    );
  } else if (profile.essential_ingredients.length) {
    console.log(
      `[synthesis-phased:C] essentials_forced_ok=[${profile.essential_ingredients.slice(0, 10).join("; ")}]`
    );
  }
  console.log(
    `[synthesis-phased:C] final core=${core.length} optional=${optional.length} subs=${subs.length}`
  );
  if (rejected_or_noise.length) {
    console.log(
      `[synthesis-phased:C] rejected_or_noise count=${rejected_or_noise.length} sample=${rejected_or_noise.slice(0, 8).join(" | ")}`
    );
  }

  const band = mergedStepBand(
    core.length,
    dynamicPb.stepMin,
    dynamicPb.stepMax
  );
  console.log(
    `[synthesis-phased:D] step_band target=${band.min}-${band.max} family=${dynamicPb.dish_family}`
  );

  const roleRows = await phaseIngredientRoles(openai, core, optional);
  console.log(
    `[synthesis-phased:roles] tagged=${roleRows.length} names=${roleRows.map((x) => x.name).slice(0, 6).join(",")}…`
  );
  const rolesLines = roleRows.map((r) => `${r.name}: ${r.role}`).join("\n");

  const subsLines = subs
    .map((s) => {
      const opts = (s.options ?? []).join(" · ");
      return `${s.ingredient} → ${opts}${s.note ? ` (${s.note})` : ""}`;
    })
    .join("\n");

  const dCtx = {
    subsLines,
    variantNotes: variant_notes,
    tipIdeas: tipCandidatesAll.slice(0, 14),
    failurePoints: dynamicPb.failure_points,
  };

  let authored = await phaseDAuthoring(
    openai,
    profile,
    playbookD,
    dynamicPb.dish_family,
    core,
    optional,
    rolesLines,
    dCtx,
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

  let injected = false;
  const inj = injectFamilyMandatorySteps(steps, dynamicPb.dish_family);
  steps = inj.steps;
  injected = inj.injected;
  if (injected) {
    console.log(
      `[synthesis-phased:D] family_mandatory_step_injection=true family=${dynamicPb.dish_family}`
    );
  }

  let miss = missingCoreInSteps(core, steps);
  let v = validateStepsVsIngredients(steps, core, optional);
  const tooMany = steps.length > band.max;
  const tooFew = steps.length < band.min;
  const verbose =
    steps.some((s) => (s.instructions?.length ?? 0) > 480) ||
    steps.length > band.max + 2;
  if (
    miss.length > 0 ||
    v.length > 0 ||
    tooMany ||
    tooFew ||
    verbose
  ) {
    const hint = [
      miss.length ? `Name every core in steps: ${miss.join(", ")}.` : "",
      ...v,
      tooMany || verbose
        ? `Max ${band.max} steps; shorten instructions (≤3 sentences each).`
        : "",
      tooFew ? `At least ${band.min} distinct steps following EXPECTED_FLOW.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`[synthesis-phased:D] retry reason=${hint.slice(0, 200)}`);
    const retryD = await phaseDAuthoring(
      openai,
      profile,
      playbookD,
      dynamicPb.dish_family,
      core,
      optional,
      rolesLines,
      dCtx,
      style,
      band,
      hint
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
      const inj2 = injectFamilyMandatorySteps(steps, dynamicPb.dish_family);
      steps = inj2.steps;
      if (inj2.injected) {
        console.log(`[synthesis-phased:D] injection_after_retry=true`);
      }
    }
  }

  if (steps.length > band.max) steps = clampSteps(steps, band.max);

  console.log(
    `[synthesis-phased:D] final_steps=${steps.length} band=${band.min}-${band.max}`
  );

  miss = missingCoreInSteps(core, steps);
  if (miss.length > 0) {
    console.warn("[synthesis-phased] core not all in steps:", miss.join(", "));
  }

  const title = profile.canonical_dish_name || fallbackTitle;
  const mergedTips = dedupeStrings(
    [...critical_tips, ...variant_notes, ...tips].filter(Boolean),
    10
  );

  const recipe_quality: RecipeQualityMeta = {
    dish_taxonomy: dynamicPb.dish_family,
    cuisine: profile.cuisine_style?.trim() || undefined,
    synthesis_style: style,
    variant_notes: dedupeStrings(variant_notes, 3),
    core_rationale: core_rationale.slice(0, 12),
    critical_tips: dedupeStrings(critical_tips, 6),
    avoid_mistakes: dedupeStrings(avoid_mistakes, 5),
    ingredient_roles: roleRows.slice(0, 24),
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
