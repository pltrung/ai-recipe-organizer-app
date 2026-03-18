import type {
  Recipe,
  RecipeDiffVersionEntry,
  RecipeIngredientsGrouped,
  RecipeLastDiff,
  RecipeQualityMeta,
  RecipeStep,
  RecipeSubstitutionEntry,
} from "./types";
import { coerceStructuredIngredient } from "./ingredientParser";
import { parseServingsCount, servingsDisplayLabel } from "./ingredientScale";
import { parseJsonStringArray } from "./recipeSourceHistory";

function parseOneStep(item: unknown, index: number): RecipeStep | null {
  if (typeof item === "string") {
    const t = item.trim();
    if (!t) return null;
    return {
      title: `Step ${index + 1}`,
      instructions: t,
      time: "As needed",
      tools: [],
      goal: "Complete before continuing.",
    };
  }
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const title =
    typeof o.title === "string" && o.title.trim()
      ? o.title.trim()
      : `Step ${index + 1}`;
  const instructions =
    typeof o.instructions === "string" && o.instructions.trim()
      ? o.instructions.trim()
      : "";
  if (!instructions) return null;
  const time =
    typeof o.time === "string" && o.time.trim()
      ? o.time.trim()
      : "As needed";
  const tools = Array.isArray(o.tools)
    ? o.tools.map((x) => String(x).trim()).filter(Boolean)
    : [];
  const goal =
    typeof o.goal === "string" && o.goal.trim()
      ? o.goal.trim()
      : "";
  let time_minutes: number | undefined;
  if (typeof o.time_minutes === "number" && !Number.isNaN(o.time_minutes)) {
    time_minutes = Math.round(o.time_minutes);
  }
  const warnings = Array.isArray(o.warnings)
    ? o.warnings.map((x) => String(x).trim()).filter(Boolean)
    : [];
  return {
    title,
    instructions,
    time,
    tools,
    goal: goal || (warnings[0] ? "" : "Complete this step before moving on."),
    time_minutes,
    ...(warnings.length ? { warnings } : {}),
  };
}

export function parseStepsFromDb(raw: unknown): RecipeStep[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeStep[] = [];
  let i = 0;
  for (const item of raw) {
    const s = parseOneStep(item, i);
    if (s) {
      out.push(s);
      i++;
    }
  }
  return out;
}

function parseIngredientsFromDb(raw: unknown): RecipeIngredientsGrouped {
  const toStructured = (arr: unknown[]): RecipeIngredientsGrouped["core"] => {
    return arr
      .map((x) => coerceStructuredIngredient(x))
      .filter((i) => (i.original || i.name || i.quantity != null));
  };

  if (Array.isArray(raw)) {
    return { core: toStructured(raw), optional: [] };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const core = Array.isArray(o.core) ? toStructured(o.core) : [];
    const optional = Array.isArray(o.optional) ? toStructured(o.optional) : [];
    return { core, optional };
  }
  return { core: [], optional: [] };
}

export { parseIngredientsFromDb };

export function parseTipsFromDb(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

export function parseSubstitutionsFromDb(
  raw: unknown
): RecipeSubstitutionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeSubstitutionEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t)
        out.push({
          ingredient: t,
          options: [],
          original: t,
          alternatives: [],
        });
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const ingredient = String(
        o.ingredient ?? o.original ?? o.name ?? ""
      ).trim();
      const options = Array.isArray(o.options)
        ? o.options.map((a) => String(a).trim()).filter(Boolean)
        : Array.isArray(o.alternatives)
          ? o.alternatives.map((a) => String(a).trim()).filter(Boolean)
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
  }
  return out;
}

export function parseMistakesFromDb(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

export function parseTechniquesFromDb(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x).trim()).filter(Boolean);
}

function parseLastDiff(raw: unknown): RecipeLastDiff | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const summary = String(o.summary ?? "").trim();
  const ing = Array.isArray(o.ingredient_changes)
    ? o.ingredient_changes.map(String)
    : [];
  const st = Array.isArray(o.step_changes)
    ? o.step_changes.map(String)
    : [];
  const ins = Array.isArray(o.new_insights)
    ? o.new_insights.map(String)
    : [];
  let key_improvements = Array.isArray(o.key_improvements)
    ? o.key_improvements.map(String).filter(Boolean)
    : [];
  if (!key_improvements.length) {
    key_improvements = [...ins, ...ing.map((x) => `Ingredients: ${x}`), ...st.map((x) => `Steps: ${x}`)].filter(
      Boolean
    );
  }
  if (!summary && !key_improvements.length) return null;
  return {
    at: String(o.at ?? ""),
    source_count_after: Number(o.source_count_after) || 0,
    summary: summary || "Recipe updated.",
    key_improvements: key_improvements.slice(0, 16),
    ...(ing.length ? { ingredient_changes: ing } : {}),
    ...(st.length ? { step_changes: st } : {}),
    ...(ins.length ? { new_insights: ins } : {}),
    structured:
      o.structured && typeof o.structured === "object"
        ? (o.structured as RecipeLastDiff["structured"])
        : undefined,
  };
}

function parseVersions(raw: unknown): RecipeDiffVersionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RecipeDiffVersionEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const vIng = Array.isArray(v.ingredient_changes)
      ? v.ingredient_changes.map(String)
      : [];
    const vSt = Array.isArray(v.step_changes) ? v.step_changes.map(String) : [];
    const vIns = Array.isArray(v.new_insights) ? v.new_insights.map(String) : [];
    let vKey = Array.isArray(v.key_improvements)
      ? v.key_improvements.map(String).filter(Boolean)
      : [];
    if (!vKey.length) {
      vKey = [...vIns, ...vIng.map((x) => `Ingredients: ${x}`), ...vSt.map((x) => `Steps: ${x}`)];
    }
    out.push({
      at: String(v.at ?? ""),
      source_count_after: Number(v.source_count_after) || 0,
      summary: String(v.summary ?? ""),
      key_improvements: vKey.slice(0, 8),
    });
  }
  return out;
}

function parseRecipeQuality(raw: unknown): RecipeQualityMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const variant_notes = Array.isArray(o.variant_notes)
    ? o.variant_notes.map(String).filter(Boolean)
    : [];
  const core_rationale = Array.isArray(o.core_rationale)
    ? (o.core_rationale as unknown[])
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const r = x as Record<string, unknown>;
          const name = String(r.name ?? "").trim();
          const why = String(r.why ?? "").trim();
          return name && why ? { name, why } : null;
        })
        .filter(Boolean)
    : [];
  const critical_tips = Array.isArray(o.critical_tips)
    ? o.critical_tips.map(String).filter(Boolean).slice(0, 6)
    : [];
  const avoid_mistakes = Array.isArray(o.avoid_mistakes)
    ? o.avoid_mistakes.map(String).filter(Boolean).slice(0, 5)
    : [];
  const ingredient_roles = Array.isArray(o.ingredient_roles)
    ? (o.ingredient_roles as unknown[])
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const r = x as Record<string, unknown>;
          const name = String(r.name ?? "").trim();
          const role = String(r.role ?? "").trim();
          return name ? { name, role } : null;
        })
        .filter(Boolean)
    : [];
  const cuisine =
    typeof o.cuisine === "string" && o.cuisine.trim()
      ? o.cuisine.trim()
      : undefined;
  return {
    dish_taxonomy: String(o.dish_taxonomy ?? "other"),
    cuisine,
    synthesis_style: String(o.synthesis_style ?? "authentic"),
    variant_notes: variant_notes.slice(0, 3),
    core_rationale: core_rationale as { name: string; why: string }[],
    critical_tips,
    avoid_mistakes,
    ingredient_roles: ingredient_roles as { name: string; role: string }[],
  };
}

export function recipeFromDbRow(data: Record<string, unknown>): Recipe {
  const ing = parseIngredientsFromDb(data.ingredients);
  const sbRaw = data.servings_base;
  let servings_base = 1;
  if (typeof sbRaw === "number" && sbRaw > 0 && sbRaw < 500) {
    servings_base = Math.round(sbRaw);
  } else {
    const fromServings = parseServingsCount(data.servings);
    if (fromServings != null) servings_base = fromServings;
  }

  return {
    id: String(data.id ?? ""),
    title: String(data.title ?? ""),
    description: String(data.description ?? ""),
    ingredients: ing,
    steps: parseStepsFromDb(data.steps),
    tips: parseTipsFromDb(data.tips),
    substitutions: parseSubstitutionsFromDb(data.substitutions),
    estimated_time: String(data.estimated_time ?? ""),
    servings: String(data.servings ?? "").trim() || servingsDisplayLabel(servings_base),
    servings_base,
    source_urls: Array.isArray(data.source_urls)
      ? data.source_urls.map(String)
      : [],
    source_platforms: Array.isArray(data.source_platforms)
      ? data.source_platforms.map(String)
      : [],
    needs_user_input: Boolean(data.needs_user_input),
    needs_review: Boolean(data.needs_review),
    sources: parseJsonStringArray(data.sources).map((s) => s.trim()),
    raw_texts: parseJsonStringArray(data.raw_texts),
    last_diff: parseLastDiff(data.last_diff),
    versions: parseVersions(data.versions),
    mistakes: parseMistakesFromDb(data.mistakes),
    techniques: parseTechniquesFromDb(data.techniques),
    recipe_quality: parseRecipeQuality(data.recipe_quality),
  };
}
