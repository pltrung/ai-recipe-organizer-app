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
  buildIngredientConsensus,
  formatConsensusForPhaseC,
} from "./ingredientConsensus";
import {
  normalizeAndDedupeGroups,
  normalizeIngredientName,
} from "./ingredientNormalize";
import { finalizeSynthesisPayload } from "./recipeOutputCleanup";
import {
  anchorLineSatisfiedInCore,
  cleanupIngredientArtifacts,
  cookingMediumOnlyInOptional,
  enforceAnchorsInCore,
  inferAnchorsFromDishName,
  materializeAnchorsFromLines,
  proteinInOptional,
  validateAnchorCoreCoverage,
} from "./dishAnchors";
import {
  buildIngredientSignals,
  rebucketSignals,
  signalsToSnapshots,
  signalsToStructuredGroups,
  type IngredientSignal,
} from "./ingredientSignalScoring";
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

  let instructions = "";
  let instructions_bullets: string[] | undefined;
  if (Array.isArray(o.instructions)) {
    const parts = (o.instructions as unknown[])
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 3);
    instructions = parts.join(" ").replace(/\s+/g, " ").trim();
    if (parts.length > 1) instructions_bullets = parts;
  } else if (typeof o.instructions === "string" && o.instructions.trim()) {
    instructions = o.instructions.trim();
  }
  if (!instructions) return null;

  let timeMin = 0;
  if (typeof o.duration_minutes === "number" && !Number.isNaN(o.duration_minutes)) {
    timeMin = Math.max(0, Math.round(o.duration_minutes));
  }
  if (typeof o.time_minutes === "number" && !Number.isNaN(o.time_minutes)) {
    timeMin = Math.max(timeMin, Math.round(o.time_minutes));
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
  const checkpoints = Array.isArray(o.checkpoints)
    ? o.checkpoints.map((w) => String(w).trim()).filter(Boolean).slice(0, 4)
    : [];
  const ingredients_used = Array.isArray(o.ingredients_used)
    ? o.ingredients_used.map((w) => String(w).trim()).filter(Boolean).slice(0, 14)
    : [];

  const step: RecipeStep = {
    title,
    instructions,
    time,
    tools,
    goal: warnings[0] || checkpoints[0] || "",
    time_minutes: timeMin > 0 ? timeMin : undefined,
    duration_minutes: timeMin > 0 ? timeMin : undefined,
  };
  if (instructions_bullets && instructions_bullets.length > 1) {
    step.instructions_bullets = instructions_bullets;
  }
  if (warnings.length) step.warnings = warnings;
  if (checkpoints.length) step.checkpoints = checkpoints;
  if (ingredients_used.length) step.ingredients_used = ingredients_used;
  return step;
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
  fallbackTitle: string,
  titleAnchors: string[]
): Promise<DishProfile | null> {
  const uniq = Array.from(
    new Set(allIngredients.map((x) => x.trim()).filter(Boolean))
  ).slice(0, 180);
  const anchorHint =
    titleAnchors.length > 0
      ? `\nDISH_STRUCTURE_HINT (from name + family logic — essentials MUST cover these slots): ${titleAnchors.join(", ")}`
      : "";
  const system = `You are a culinary expert. Given raw ingredient mentions from one or more sources about the SAME dish, infer identity and essentials.

Return STRICT JSON:
{
  "canonical_dish_name": string,
  "cuisine_style": string,
  "essential_ingredients": string[],
  "optional_acceptable": string[]
}

essential_ingredients: defining items matching DISH STRUCTURE (protein, coating, fry oil, broth, etc.) — NOT vote counting.
optional_acceptable: true garnishes, optional aromatics (ginger, garlic, sesame oil), upgrades.
cuisine_style: e.g. Vietnamese, Italian, Japanese, Thai, regional Chinese, etc.

CRITICAL:
- At least one protein (by name) if the dish is meat/fish/tofu-forward.
- Required cooking medium (e.g. fry oil) when the dish is deep-fried or stir-fried.
- Required structure (coating starch/flour for breaded; noodles+broth for soup; dough+sauce+cheese for pizza).
- For karaage / fried chicken / katsu / tempura: chicken (or protein) + starch/flour + frying oil + soy or main marinade base in essentials; ginger/sesame oil stay optional unless defining.
- Do not let noisy blogs demote the main protein to optional.`;

  const user = `Working title hint: "${fallbackTitle}"${anchorHint}\n\nIngredient mentions (noisy list):\n${uniq.map((x, i) => `${i + 1}. ${x}`).join("\n")}`;

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

function coreItemMatchesMaterializedAnchors(
  c: StructuredIngredient,
  materialized: { line: string }[]
): boolean {
  for (const { line } of materialized) {
    if (anchorLineSatisfiedInCore([c], line)) return true;
  }
  return false;
}

/** Core items only mentioned by low-confidence sources — disallow unless essential/anchor. */
function coreFromLowOnlySources(
  core: StructuredIngredient[],
  numbered: {
    line: string;
    sourceConf: SourceConfidence;
  }[],
  essentials: string[],
  signatureIngredients: string[],
  materializedAnchors: { line: string }[]
): string[] {
  if (!hasConfidentSource(numbered)) return [];
  const sigNorm = signatureIngredients.map((s) => normalizeIngredientName(s).toLowerCase()).filter(Boolean);
    const violations: string[] = [];
    for (const c of core) {
      const cn = normalizeIngredientName(c.name).toLowerCase();
      if (coreItemMatchesMaterializedAnchors(c, materializedAnchors)) continue;
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

/** Phase D: min 5, target 6–9, hard max 12 */
function mergedStepBand(
  coreCount: number,
  famMin: number,
  famMax: number
): { min: number; max: number } {
  const min = 5;
  let max = coreCount > 11 ? 12 : 9;
  max = Math.min(12, Math.max(max, Math.min(famMax || 9, 12)));
  if (max < min) max = min;
  void famMin;
  return { min, max };
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

function mergeEssentialLists(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...a, ...b]) {
    const t = String(x).trim();
    if (!t) continue;
    const k = t.toLowerCase().slice(0, 100);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.slice(0, 28);
}

async function phasePreCIngredientRoleMap(
  openai: InstanceType<typeof import("openai").default>,
  candidateLines: string[],
  dishAnchors: string
): Promise<{ block: string; roleByLine: Map<string, string> }> {
  const empty = { block: "", roleByLine: new Map<string, string>() };
  const sample = Array.from(
    new Set(candidateLines.map((t) => t.trim()).filter(Boolean))
  ).slice(0, 52);
  if (!sample.length) return empty;
  const p = await chatJson(
    openai,
    `Map each ingredient line to exactly ONE role:

structure | protein | base | coating | cooking_medium | flavor | garnish

Priority for importance scoring: protein/structure highest, then base/coating, cooking_medium, flavor, garnish lowest.

Return STRICT JSON: { "mappings": [{ "line": string, "role": string }] }
Include every input line once (copy line text exactly).`,
    `DISH_ANCHOR_SLOTS: ${dishAnchors || "—"}

INGREDIENT_LINES:
${sample.map((l, i) => `${i + 1}. ${l}`).join("\n")}`
  );
  const roleByLine = new Map<string, string>();
  if (!p || !Array.isArray(p.mappings)) return empty;
  const rows: string[] = [];
  for (const x of p.mappings as unknown[]) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const line = String(o.line ?? "").trim();
    const role = String(o.role ?? "").trim();
    if (line && role) {
      roleByLine.set(line, role);
      rows.push(`${line.slice(0, 120)} → ${role}`);
    }
  }
  const block = rows.length
    ? `PRE_MAPPED_ROLES:\n${rows.slice(0, 52).join("\n")}`
    : "";
  return { block, roleByLine };
}

async function phaseCSubstitutionsOnly(
  openai: InstanceType<typeof import("openai").default>,
  profile: DishProfile,
  core: StructuredIngredient[],
  optional: StructuredIngredient[],
  playbookC: string,
  synthesisStyle: SynthesisStyle,
  fixHint?: string
): Promise<{
  subs: RecipeSubstitutionEntry[];
  core_rationale: { name: string; why: string }[];
  variant_notes: string[];
} | null> {
  const coreLines = core
    .map((c) => `${c.quantity ?? "—"} ${c.unit} ${c.name}`.trim())
    .join("\n");
  const optLines = optional
    .map((c) => `${c.quantity ?? "—"} ${c.unit} ${c.name}`.trim())
    .join("\n");
  const system = `Core and optional ingredient lists are FINAL (importance-scored). Do NOT change membership.

Output ONLY substitutions (role-aligned swaps), brief core_rationale (why each core item matters), variant_notes.

STYLE: ${synthesisStyle} — ${STYLE_GUIDE[synthesisStyle]}

Return STRICT JSON:
{
  "substitutions": [{ "ingredient": string, "options": string[], "note": string }],
  "core_rationale": [{ "name": string, "why": string }],
  "variant_notes": string[]
}
Max 10 subs, 12 rationale rows, 3 variant_notes.`;

  const user = `${playbookC.slice(0, 6000)}

DISH: ${profile.canonical_dish_name}

CORE (fixed):
${coreLines || "(none)"}

OPTIONAL (fixed):
${optLines || "(none)"}
${fixHint ? `\n\nFIX:\n${fixHint}` : ""}`;

  const p = await chatJson(openai, system, user);
  if (!p) return null;
  return {
    subs: substitutionsFromPhaseC(p.substitutions),
    core_rationale: Array.isArray(p.core_rationale)
      ? (p.core_rationale as unknown[])
          .map((x) => {
            if (!x || typeof x !== "object") return null;
            const o = x as Record<string, unknown>;
            const name = String(o.name ?? "").trim();
            const why = String(o.why ?? "").trim();
            return name && why ? { name, why: why.slice(0, 180) } : null;
          })
          .filter(Boolean) as { name: string; why: string }[]
      : [],
    variant_notes: Array.isArray(p.variant_notes)
      ? p.variant_notes
          .map((x) => String(x).trim())
          .filter(Boolean)
          .slice(0, 3)
      : [],
  };
}

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
  consensusBlock: string,
  roleMapBlock: string,
  fixHint?: string
): Promise<{
  core: StructuredIngredient[];
  optional: StructuredIngredient[];
  subs: RecipeSubstitutionEntry[];
  core_rationale: { name: string; why: string }[];
  variant_notes: string[];
  rejected_or_noise: string[];
} | null> {
  const system = `Strict ingredient JUDGE — ONE coherent recipe. Candidates: [id] (S# CONFIDENCE) line.

DISH_ANCHOR_OVERRIDE (HARD): Playbook dish_anchors define mandatory CORE slots (protein, coating_starch, frying_oil, marinade_base, broth, noodles, etc.). ANY candidate that fills an anchor slot MUST be CORE — overrides low confidence and frequency. Ginger, garlic, sesame oil are usually OPTIONAL unless anchor says otherwise.

PRE_MAPPED_ROLES: When role is protein/coating/cooking_medium/base/structure and the dish anchor requires that slot → CORE.

CONFIDENCE (only when not anchor-mapped):
- high/medium → core when aligned.
- low → optional UNLESS anchor or essential.

CLUSTER: one core slot per concept (merge chicken thigh variants into one best line).

ESSENTIALS: profile.essential_ingredients MUST appear in core. Never put main protein or fry oil only in optional.

SUBSTITUTIONS: same role only. rejected_or_noise: blog junk lines ("see note 1", "optional garnish").

No duplicate concepts across core/optional/subs. Strip "see blog" from names.

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
  const user = `${playbookC}\n\n${consensusBlock || "(no consensus)"}\n\n${roleMapBlock || "(no role map)"}\n\n---\n\nPROFILE:\n${JSON.stringify(profile, null, 2)}\n\nCANDIDATES:\n${lines.join("\n")}${fixHint ? `\n\nCORRECTION REQUIRED:\n${fixHint}` : ""}`;

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

  core = core.map(cleanupIngredientArtifacts);
  optional = optional.map(cleanupIngredientArtifacts);

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
    `Tag each ingredient with ONE role: structure | protein | base | coating | cooking_medium | flavor | garnish
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
    .map((s) => {
      const iu = (s.ingredients_used ?? []).join(" ");
      const bul = (s.instructions_bullets ?? []).join(" ");
      return `${s.title} ${s.instructions} ${iu} ${bul}`.toLowerCase();
    })
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
  const text = steps
    .map((s) =>
      [s.title, s.instructions, ...(s.instructions_bullets ?? [])]
        .join(" ")
        .toLowerCase()
    )
    .join(" ");
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

/** Before Phase D: pick dominant storyline; secondary → tips only (never step lists). */
async function phaseDStepFlowHint(
  openai: InstanceType<typeof import("openai").default>,
  extractions: PerSourceExtraction[],
  chunks: SourceChunk[]
): Promise<{ narrative: string; extraTipIdeas: string[] }> {
  const blocks: string[] = [];
  for (let i = 0; i < extractions.length && i < chunks.length; i++) {
    const conf = chunks[i]?.confidence ?? "medium";
    const sc = extractions[i]!.step_candidates.slice(0, 14).filter(Boolean);
    if (!sc.length) continue;
    blocks.push(
      `[Source ${i} confidence=${conf}]\n${sc.map((s, j) => `${j + 1}. ${s}`).join("\n")}`
    );
  }
  if (blocks.length === 0) return { narrative: "", extraTipIdeas: [] };
  const p = await chatJson(
    openai,
    `You see procedural FRAGMENTS from multiple web/video sources. They often CONFLICT or duplicate.

Return STRICT JSON:
{
  "dominant_one_liner": string,
  "secondary_as_tips_only": string[]
}

dominant_one_liner: ONE sentence describing the single best default cooking story (prefer high/medium-confidence sources over low).
secondary_as_tips_only: up to 6 short notes (alt timing, optional tweak) — NOT steps.

Do NOT output recipe steps or numbered procedures.`,
    blocks.join("\n\n---\n\n").slice(0, 14_000)
  );
  if (!p) return { narrative: "", extraTipIdeas: [] };
  const narrative = String(p.dominant_one_liner ?? "").trim().slice(0, 400);
  const extra = Array.isArray(p.secondary_as_tips_only)
    ? (p.secondary_as_tips_only as unknown[])
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  return { narrative, extraTipIdeas: extra };
}

function isBannedSectionTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (
    /^to\s+(marinate|fry|bake|simmer|cook|prep|prepare|make|assemble|chill|rest|serve|mix|combine)/.test(
      t
    )
  )
    return true;
  if (
    /^for\s+the\s+(sauce|marinade|dressing|gravy|dip|dipping|broth|stock|topping|filling|batter|coating)/.test(
      t
    )
  )
    return true;
  if (/^before\s+(you\s+)?(start|begin)/.test(t)) return true;
  if (/^prep\s*:/.test(t) || /^preparation\s*$/i.test(t)) return true;
  return false;
}

function stepBodyText(s: RecipeStep): string {
  return `${s.title} ${s.instructions} ${(s.instructions_bullets ?? []).join(" ")}`;
}

function validateSingleFlowOrder(steps: RecipeStep[]): string | null {
  const texts = steps.map((s) => stepBodyText(s).toLowerCase());
  const heat = /\b(fry|deep-fry|bake|simmer|boil|roast|grill|sear|cook until|heat oil)\b/;
  const finish = /\b(serve|plate up|garnish and serve|divide among plates)\b/;
  let firstHeat = -1;
  let firstFinish = -1;
  for (let i = 0; i < texts.length; i++) {
    if (heat.test(texts[i]!) && firstHeat < 0) firstHeat = i;
    if (finish.test(texts[i]!) && firstFinish < 0) firstFinish = i;
  }
  if (firstHeat >= 0 && firstFinish >= 0 && firstFinish < firstHeat) {
    return "Reorder: serving/garnish steps must come after main cooking.";
  }
  return null;
}

function collectStepValidationIssues(
  steps: RecipeStep[],
  core: StructuredIngredient[],
  optional: StructuredIngredient[],
  band: { min: number; max: number },
  _expectedFlow: string[]
): string[] {
  void _expectedFlow;
  const issues: string[] = [];
  const STRICT_MIN = 5;
  const STRICT_MAX = 12;
  if (steps.length < STRICT_MIN) {
    issues.push(
      `ONE unified recipe: at least ${STRICT_MIN} steps (merge parallel source flows into one sequence).`
    );
  }
  if (steps.length > STRICT_MAX) {
    issues.push(
      `Max ${STRICT_MAX} steps — compress duplicate flows; one canonical sequence only.`
    );
  }
  const miss = missingCoreInSteps(core, steps);
  if (miss.length) {
    issues.push(
      `Every core ingredient must appear in step text: ${miss.slice(0, 10).join(", ")}.`
    );
  }
  issues.push(...validateStepsVsIngredients(steps, core, optional));
  const orderMsg = validateSingleFlowOrder(steps);
  if (orderMsg) issues.push(orderMsg);

  const normTitles = steps.map((s) => s.title.toLowerCase().replace(/\s+/g, " ").trim());
  if (new Set(normTitles).size !== normTitles.length) {
    issues.push("Duplicate step titles — ONE step per action; merge duplicates.");
  }

  const bodies = steps.map((s) =>
    s.instructions
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100)
  );
  for (let i = 1; i < bodies.length; i++) {
    if (bodies[i]!.length > 35 && bodies[i] === bodies[i - 1]) {
      issues.push("Remove duplicated step instructions — merge into one step.");
      break;
    }
  }

  for (const s of steps) {
    if (isBannedSectionTitle(s.title)) {
      issues.push(
        `Title "${s.title}" is a blog section header — rewrite as direct action (e.g. "Marinate the chicken").`
      );
    }
    const full = stepBodyText(s).toLowerCase();
    if (/mix everything|combine all ingredients|throw all|dump everything|just mix/i.test(full)) {
      issues.push(`Step "${s.title}" is too vague — one clear action.`);
    }
    const sentences = s.instructions.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (s.instructions.length > 520) {
      issues.push(`Step "${s.title}": shorten instructions (max ~3 sentences).`);
    }
    if (sentences.length > 4) {
      issues.push(`Step "${s.title}": at most 3 sentences in instructions.`);
    }
    const hasTime =
      (s.time_minutes ?? 0) > 0 ||
      (s.duration_minutes ?? 0) > 0 ||
      /\b(until|when|about\s*\d|\d+\s*min|minutes|°f|°c|preheat|overnight)\b/i.test(
        full
      );
    if (!hasTime) {
      issues.push(
        `Step "${s.title}": add duration_minutes OR time/condition (until…, about N min).`
      );
    }
  }
  return Array.from(new Set(issues)).slice(0, 16);
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
    /** Dominant flow one-liner — orientation only, not steps to copy */
    sourceFlowNarrative: string;
  },
  synthesisStyle: SynthesisStyle,
  band: { min: number; max: number },
  expectedFlowLines: string[],
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
  const flowBlock =
    expectedFlowLines.length > 0
      ? expectedFlowLines.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "(follow dish logic)";

  const system = `You write ONE canonical recipe for Recipe Cloud — a single chef-authored flow.

STRICT — SOURCE MATERIAL:
- Do NOT copy, paste, or stitch together step_candidates / procedural fragments from sources.
- Do NOT follow multiple blog timelines in parallel. Generate a NEW unified sequence from scratch.
- Inputs you MAY use: finalized ingredients (below), EXPECTED_FLOW, ingredient_roles, playbook, and the one-line ORIENTATION sentence only (it is not a step list).

SINGLE FLOW:
- If sources disagreed, you already chose one dominant story in ORIENTATION. Implement THAT ONE flow only.
- Merge useful ideas (timing, warnings) into the same sequence — never output two alternate step paths.

BANNED step titles (blog sections — rewrite as actions):
- No "To marinate", "To fry", "For the sauce", "Before you start", "Prep:", section headers.
- Each title = short direct action: "Marinate the chicken", "Fry until golden".

Return STRICT JSON:
{
  "summary": string (≤2 sentences),
  "servings": number,
  "steps": [{
    "title": string,
    "instructions": string,
    "duration_minutes": number,
    "tools": string[],
    "warnings": string[]
  }],
  "tips": string[],
  "critical_tips": string[],
  "avoid_mistakes": string[]
}

STEP RULES:
- Minimum ${band.min} steps, target 6–9, maximum 12. If you exceed ${band.max}, merge redundant steps (e.g. multiple fry steps → one fry step; multiple marinade notes → one marinate step).
- instructions: ONE string, 1–3 sentences max. No bullet lists inside. No duplicated paragraphs.
- Collapse similar actions across imagined sources into ONE clearer step.
- Follow EXPECTED_FLOW order. One main action per step.
- duration_minutes: realistic; or 0 only if text has clear condition ("until golden").
- warnings: 0–2 per step, real risks only.
- Name every core ingredient somewhere across steps: [${coreNames}].
- Only listed ingredients + water/salt/oil.

${playbookD}

FAMILY CHECKLIST: ${familyMandatory}

STYLE ${synthesisStyle}: ${STYLE_GUIDE[synthesisStyle]}`;

  const tipBlock =
    dCtx.tipIdeas.length > 0
      ? dCtx.tipIdeas.map((t, i) => `${i + 1}. ${t}`).join("\n")
      : "(none)";
  const failBlock = dCtx.failurePoints.length
    ? dCtx.failurePoints.join("\n- ")
    : "(none)";

  const orient =
    dCtx.sourceFlowNarrative.trim() ||
    "(No multi-source fragment summary — infer one flow from dish + ingredients + playbook.)";

  const user = `DISH: ${profile.canonical_dish_name} (${profile.cuisine_style}) | family: ${dishFamilyLabel}

ORIENTATION — dominant storyline only (NOT steps to copy; write fresh steps from ingredients + flow):
${orient}

EXPECTED_FLOW — your single recipe must follow this order (merge beats into one step where needed):
${flowBlock}

INGREDIENT ROLES:
${rolesLines || "(none)"}

FINALIZED INGREDIENTS (Phase C — sole ingredient truth):
${ingList}

SUBSTITUTIONS (if cook swaps):
${dCtx.subsLines || "(none)"}

VARIANT NOTES:
${dCtx.variantNotes.length ? dCtx.variantNotes.map((v, i) => `${i + 1}. ${v}`).join("\n") : "(none)"}

TIP / WARNING IDEAS — fold into critical_tips, avoid_mistakes, tips, or step warnings; never as extra step sequences:
${tipBlock}

PLAYBOOK FAILURE POINTS:
- ${failBlock}
${fixHint ? `\n\nVALIDATION FIX (required):\n${fixHint}` : ""}`;

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
    const bullets = group.flatMap((g) =>
      g.instructions_bullets?.length
        ? g.instructions_bullets
        : g.instructions.split("\n").filter(Boolean)
    );
    const instructions = bullets.length
      ? bullets.join("\n")
      : group.map((g) => g.instructions).join("\nThen ");
    const title = group[0]!.title;
    const tools = Array.from(new Set(group.flatMap((g) => g.tools))).slice(
      0,
      8
    );
    const warnings = group.flatMap((g) => g.warnings ?? []).slice(0, 3);
    const checkpoints = group.flatMap((g) => g.checkpoints ?? []).slice(0, 4);
    const ingredients_used = Array.from(
      new Set(group.flatMap((g) => g.ingredients_used ?? []))
    ).slice(0, 16);
    const maxMin = Math.max(
      ...group.map((g) => g.time_minutes ?? g.duration_minutes ?? 0),
      0
    );
    merged.push({
      title,
      instructions,
      instructions_bullets: bullets.length > 1 ? bullets : undefined,
      time: maxMin > 0 ? `${maxMin} min` : "As needed",
      tools,
      goal: warnings[0] || checkpoints[0] || "",
      time_minutes: maxMin > 0 ? maxMin : undefined,
      duration_minutes: maxMin > 0 ? maxMin : undefined,
      warnings: warnings.length ? warnings : undefined,
      checkpoints: checkpoints.length ? checkpoints : undefined,
      ingredients_used: ingredients_used.length ? ingredients_used : undefined,
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
    (await phaseBDishProfile(
      openai,
      allIng,
      fallbackTitle,
      inferAnchorsFromDishName(fallbackTitle)
    )) ?? {
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

  const materializedAnchors = materializeAnchorsFromLines(
    dynamicPb.dish_anchors ?? [],
    allIng
  );
  profile.essential_ingredients = mergeEssentialLists(
    mergeEssentialLists(
      profile.essential_ingredients,
      materializedAnchors.map((m) => m.line)
    ),
    dynamicPb.signature_ingredients.slice(0, 6)
  );

  console.log(
    `[synthesis-phased:playbook] family=${dynamicPb.dish_family} dish_anchors=[${(dynamicPb.dish_anchors ?? []).join(", ")}] materialized=${materializedAnchors.length} cuisine=${dynamicPb.cuisine}`
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

  const consensusRows = buildIngredientConsensus(
    numbered,
    dynamicPb.signature_ingredients,
    profile.essential_ingredients
  );
  const consensusBlock = formatConsensusForPhaseC(consensusRows, [
    ...(dynamicPb.dish_anchors ?? []),
    ...dynamicPb.signature_ingredients,
    ...profile.essential_ingredients,
  ]);
  console.log(
    `[synthesis-phased:consensus] clusters=${consensusRows.length} top=${consensusRows.slice(0, 5).map((r) => r.name).join(",")}`
  );

  const roleRes = await phasePreCIngredientRoleMap(
    openai,
    allIng,
    (dynamicPb.dish_anchors ?? []).join("; ")
  );
  const roleMapBlock = roleRes.block;
  const anchorTokensForScore = [
    ...(dynamicPb.dish_anchors ?? []),
    ...profile.essential_ingredients,
    ...dynamicPb.signature_ingredients.slice(0, 6),
  ].filter(Boolean);

  function phaseCFixReason(
    core: StructuredIngredient[],
    optional: StructuredIngredient[],
    numberedLocal: typeof numbered,
    skipLowOnlyDemote?: boolean
  ): string | null {
    const parts: string[] = [];
    const miss = strictEssentialsMissing(core, profile.essential_ingredients);
    if (miss.length) {
      parts.push(
        `CORE must include every essential: ${miss.join("; ")}. Add quantities where possible.`
      );
    }
    parts.push(...validateAnchorCoreCoverage(core, materializedAnchors));
    const optEss = optionalHasEssentialOverlap(
      optional,
      profile.essential_ingredients
    );
    if (optEss.length) {
      parts.push(
        `These are dish-defining — move from optional to CORE: ${optEss.join("; ")}.`
      );
    }
    if (
      proteinInOptional(
        optional,
        (dynamicPb.dish_anchors ?? []).some((a) => /protein/i.test(a))
      )
    ) {
      parts.push(
        "Main protein is in OPTIONAL — move to CORE (dish anchor: protein)."
      );
    }
    if (cookingMediumOnlyInOptional(optional, dynamicPb.dish_anchors ?? [])) {
      parts.push(
        "Frying/cooking oil is only in OPTIONAL — move to CORE (dish anchor: frying_oil)."
      );
    }
    if (duplicateNormalizedInCore(core)) {
      parts.push(
        "One core line per ingredient concept only (dedupe synonyms)."
      );
    }
    const coreKeys = new Set(
      core.map((c) => normalizeIngredientName(c.name).toLowerCase())
    );
    for (const o of optional) {
      const k = normalizeIngredientName(o.name).toLowerCase();
      if (k && coreKeys.has(k)) {
        parts.push(`Remove duplicate from optional: ${o.name} (already in core).`);
        break;
      }
    }
    if (!skipLowOnlyDemote) {
      const lowOnly = coreFromLowOnlySources(
        core,
        numberedLocal,
        profile.essential_ingredients,
        dynamicPb.signature_ingredients,
        materializedAnchors
      );
      if (lowOnly.length) {
        parts.push(
          `Demote to optional or drop (only weak-source, not essential/signature/anchor): ${lowOnly.join("; ")}.`
        );
      }
    }
    return parts.length ? parts.join(" ") : null;
  }

  type PhaseCOut = {
    core: StructuredIngredient[];
    optional: StructuredIngredient[];
    subs: RecipeSubstitutionEntry[];
    core_rationale: { name: string; why: string }[];
    variant_notes: string[];
    rejected_or_noise: string[];
    signals: IngredientSignal[];
  };

  let phaseC: PhaseCOut | null = null;
  let workingSignals: IngredientSignal[] = [];
  let coreScoreMin = 70;
  let subsFix: string | undefined;

  for (let cAttempt = 0; cAttempt < 4; cAttempt++) {
    let sigs =
      cAttempt > 0
        ? rebucketSignals(workingSignals, coreScoreMin)
        : buildIngredientSignals(
            numbered,
            roleRes.roleByLine,
            anchorTokensForScore,
            materializedAnchors,
            coreScoreMin
          );
    workingSignals = sigs;
    let { core: cr, optional: op } = signalsToStructuredGroups(sigs);
    const enf = enforceAnchorsInCore(cr, op, materializedAnchors);
    cr = enf.core;
    op = enf.optional;
    const mg = normalizeAndDedupeGroups({ core: cr, optional: op });
    cr = mg.core.map(cleanupIngredientArtifacts);
    op = mg.optional.map(cleanupIngredientArtifacts);
    const ckeys = new Set(
      cr.map((c) => normalizeIngredientName(c.name).toLowerCase())
    );
    op = op.filter((x) => {
      const k = normalizeIngredientName(x.name).toLowerCase();
      return !k || !ckeys.has(k);
    });

    if (cr.length === 0) {
      coreScoreMin = Math.max(30, coreScoreMin - 10);
      console.log(
        `[synthesis-phased:C] signal retry empty core → coreMin=${coreScoreMin}`
      );
      continue;
    }

    const reason = phaseCFixReason(cr, op, numbered, true);
    if (reason) {
      console.log(
        `[synthesis-phased:C] signal attempt=${cAttempt + 1} fix=${reason.slice(0, 160)}`
      );
      coreScoreMin = cAttempt === 0 ? 65 : cAttempt === 1 ? 58 : 52;
      if (cAttempt === 3) {
        const fallback = await phaseCIngredients(
          openai,
          profile,
          numbered,
          style,
          playbookC,
          consensusBlock,
          roleMapBlock,
          reason
        );
        if (fallback?.core.length) {
          phaseC = {
            ...fallback,
            signals: workingSignals,
          };
        }
        break;
      }
      continue;
    }

    const meta =
      (await phaseCSubstitutionsOnly(
        openai,
        profile,
        cr,
        op,
        playbookC,
        style,
        subsFix
      )) ?? {
        subs: [] as RecipeSubstitutionEntry[],
        core_rationale: [] as { name: string; why: string }[],
        variant_notes: [] as string[],
      };
    let subs = filterSubstitutionsQuality(meta.subs, cr, op);
    phaseC = {
      core: cr,
      optional: op,
      subs,
      core_rationale: meta.core_rationale,
      variant_notes: meta.variant_notes,
      rejected_or_noise: [],
      signals: workingSignals,
    };
    if (cAttempt > 0) {
      console.log(`[synthesis-phased:C] importance scores settled after ${cAttempt + 1} attempts`);
    }
    break;
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

  const enforced = enforceAnchorsInCore(core, optional, materializedAnchors);
  core = enforced.core;
  optional = enforced.optional;
  const mergedGroups = normalizeAndDedupeGroups({ core, optional });
  core = mergedGroups.core;
  optional = mergedGroups.optional;
  const optDedup: StructuredIngredient[] = [];
  const ckeys = new Set(
    core.map((c) => normalizeIngredientName(c.name).toLowerCase())
  );
  for (const o of optional) {
    const k = normalizeIngredientName(o.name).toLowerCase();
    if (k && ckeys.has(k)) continue;
    optDedup.push(o);
  }
  optional = optDedup;
  phaseC = { ...phaseC, core, optional };

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

  const flowHint = await phaseDStepFlowHint(openai, extractions, nonEmpty);
  console.log(
    `[synthesis-phased:D] flow_hint len=${flowHint.narrative.length} secondary_tips=${flowHint.extraTipIdeas.length}`
  );

  const dCtx = {
    subsLines,
    variantNotes: variant_notes,
    tipIdeas: [...flowHint.extraTipIdeas, ...tipCandidatesAll].slice(0, 18),
    failurePoints: dynamicPb.failure_points,
    sourceFlowNarrative: flowHint.narrative,
  };

  const expectedFlow = dynamicPb.expected_flow ?? [];
  let authored: Awaited<ReturnType<typeof phaseDAuthoring>> = null;
  let dFix: string | undefined;
  for (let dAtt = 0; dAtt < 4; dAtt++) {
    authored = await phaseDAuthoring(
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
      expectedFlow,
      dFix
    );
    if (!authored || authored.steps.length === 0) {
      dFix = "Return valid JSON with non-empty steps (chef structure).";
      continue;
    }
    let stepsTry = authored.steps;
    const inj = injectFamilyMandatorySteps(stepsTry, dynamicPb.dish_family);
    stepsTry = inj.steps;
    if (stepsTry.length > 12) stepsTry = clampSteps(stepsTry, 12);
    if (inj.injected && dAtt === 0) {
      console.log(
        `[synthesis-phased:D] family_mandatory_step_injection=true family=${dynamicPb.dish_family}`
      );
    }
    const issues = collectStepValidationIssues(
      stepsTry,
      core,
      optional,
      band,
      expectedFlow
    );
    if (issues.length === 0) {
      authored = { ...authored, steps: stepsTry };
      break;
    }
    dFix = issues.join("\n");
    console.log(
      `[synthesis-phased:D] attempt=${dAtt + 1} validation=${issues.slice(0, 2).join(" | ").slice(0, 180)}`
    );
    if (dAtt === 3) authored = { ...authored, steps: stepsTry };
  }

  if (!authored || authored.steps.length === 0) return null;

  let steps = authored.steps;
  let tips = authored.tips;
  let summary = authored.summary;
  let servings_base = authored.servings_base;
  let critical_tips = authored.critical_tips;
  let avoid_mistakes = authored.avoid_mistakes;

  if (steps.length > 12) steps = clampSteps(steps, 12);
  else if (steps.length > band.max) steps = clampSteps(steps, band.max);

  console.log(
    `[synthesis-phased:D] final_steps=${steps.length} band=${band.min}-${band.max}`
  );

  const miss = missingCoreInSteps(core, steps);
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
    ingredient_signals: signalsToSnapshots(phaseC.signals),
  };

  const payloadRaw: SynthesisDbPayload = {
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

  const payload = finalizeSynthesisPayload(payloadRaw, {
    ingredient_roles: roleRows,
  });

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
