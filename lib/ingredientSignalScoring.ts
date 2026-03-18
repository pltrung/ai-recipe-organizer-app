/**
 * Ingredient importance scoring — core vs optional from dish identity, not DOM noise.
 */

import type { SourceConfidence } from "./sourceSynthesisConfidence";
import type { StructuredIngredient } from "./types";
import { coerceStructuredIngredient } from "./ingredientParser";
import { normalizeIngredientName, normalizeUnit } from "./ingredientNormalize";
import {
  type MaterializedAnchor,
} from "./dishAnchors";
import type { CanonicalIngredientEntity } from "./ingredientCanonicalization";

export type IngredientSignal = {
  name: string;
  frequency: number;
  confidence_levels: string[];
  role: string;
  anchor_match: boolean;
  frequency_score: number;
  confidence_score: number;
  role_score: number;
  anchor_score: number;
  total_score: number;
  /** Representative raw line for structured parse */
  best_line: string;
  bucket: "core" | "optional" | "ignore";
};

const CONF_TO_SCORE: Record<string, number> = {
  high: 100,
  medium_high: 80,
  medium: 60,
  low: 30,
};

function roleScore(role: string): number {
  const r = role.toLowerCase().trim();
  if (r === "protein" || r === "structure") return 100;
  if (r === "base" || r === "coating") return 85;
  if (r === "cooking_medium") return 80;
  if (r === "flavor" || r === "flavor_base" || r === "aroma" || r === "richness")
    return 50;
  if (r === "garnish" || r === "optional_enhancement") return 20;
  return 40;
}

function anchorTokenMatch(nameNorm: string, tokens: string[]): boolean {
  const n = nameNorm.toLowerCase();
  for (const a of tokens) {
    const an = normalizeIngredientName(a).toLowerCase();
    if (!an || an.length < 2) continue;
    if (n.includes(an) || an.includes(n)) return true;
    const aw = an.split(/\s+/).filter((w) => w.length > 3);
    if (aw.some((w) => n.includes(w))) return true;
  }
  return false;
}

/** Anchor match uses canonical ingredient name only (not raw variant lines). */
function materializedMatchesCanonicalName(
  canonicalName: string,
  materialized: MaterializedAnchor[]
): boolean {
  const cn = normalizeIngredientName(canonicalName).toLowerCase();
  if (!cn || cn.length < 2) return false;
  for (const m of materialized) {
    const ing = coerceStructuredIngredient(m.line);
    const an = normalizeIngredientName(
      ing.name || ing.original || m.line
    ).toLowerCase();
    if (!an) continue;
    if (cn === an || cn.includes(an) || an.includes(cn)) return true;
    const aw = an.split(/\s+/).filter((w) => w.length > 2);
    if (aw.some((w) => cn.includes(w))) return true;
  }
  return false;
}

function lookupRole(line: string, roleByLine: Map<string, string>): string {
  const t = line.trim();
  if (roleByLine.has(t)) return roleByLine.get(t)!;
  for (const [k, v] of Array.from(roleByLine.entries())) {
    if (k.length > 8 && (t.includes(k) || k.includes(t))) return v;
  }
  return "flavor";
}

/**
 * Score pre-canonicalized entities only. Anchors match **canonical_name** (not raw lines).
 */
export function buildIngredientSignalsFromCanonical(
  entities: CanonicalIngredientEntity[],
  roleByLine: Map<string, string>,
  dishAnchorTokens: string[],
  materialized: MaterializedAnchor[],
  coreScoreMin = 70
): IngredientSignal[] {
  const anchorTokens = [
    ...dishAnchorTokens,
    ...materialized.map((m) => m.line),
  ].filter(Boolean);

  const signals: IngredientSignal[] = [];
  for (const ent of entities) {
    const cn = ent.canonical_name.trim();
    if (!cn) continue;

    const sourceConf = new Map<number, SourceConfidence>();
    for (const v of ent.variants) {
      const w = CONF_TO_SCORE[v.sourceConf] ?? 50;
      const prev = sourceConf.get(v.sourceIndex);
      const pw = prev ? CONF_TO_SCORE[prev] ?? 0 : 0;
      if (!prev || w > pw) sourceConf.set(v.sourceIndex, v.sourceConf);
    }
    const sources = Array.from(sourceConf.keys());
    const confLevels = sources.map((si) => sourceConf.get(si)!);
    const frequency = sources.length;
    const frequency_score = Math.min(100, frequency * 30);
    let confidence_score = 0;
    for (const c of confLevels) {
      confidence_score = Math.max(confidence_score, CONF_TO_SCORE[c] ?? 50);
    }

    let bestRoleScore = 0;
    let bestRole = ent.ingredient_type === "protein" ? "protein" : "flavor";
    for (const v of ent.variants) {
      const r = lookupRole(v.line, roleByLine);
      const rs = roleScore(r);
      if (rs > bestRoleScore) {
        bestRoleScore = rs;
        bestRole = r;
      }
    }

    const nameNorm = normalizeIngredientName(cn).toLowerCase();
    const anchor_match =
      anchorTokenMatch(nameNorm, anchorTokens) ||
      materializedMatchesCanonicalName(cn, materialized);

    const anchor_score = anchor_match ? 100 : 0;
    let total_score =
      frequency_score * 0.3 +
      confidence_score * 0.2 +
      bestRoleScore * 0.25 +
      anchor_score * 0.25;

    if (anchor_match) total_score = Math.max(total_score, 85);

    let bucket: "core" | "optional" | "ignore";
    if (total_score >= coreScoreMin) bucket = "core";
    else if (total_score >= 30) bucket = "optional";
    else bucket = "ignore";

    let pickLine = ent.variants[0]!.line;
    let bestConf = -1;
    for (const v of ent.variants) {
      const sc = CONF_TO_SCORE[v.sourceConf] ?? 0;
      if (sc > bestConf) {
        bestConf = sc;
        pickLine = v.line;
      }
    }

    signals.push({
      name: normalizeIngredientName(cn) || cn,
      frequency,
      confidence_levels: confLevels,
      role: bestRole,
      anchor_match,
      frequency_score,
      confidence_score,
      role_score: bestRoleScore,
      anchor_score,
      total_score: Math.round(total_score * 10) / 10,
      best_line: pickLine,
      bucket,
    });
  }

  signals.sort((a, b) => b.total_score - a.total_score);
  return signals;
}

/** Re-bucket after adjusting thresholds (retry). */
export function rebucketSignals(
  signals: IngredientSignal[],
  coreMin: number
): IngredientSignal[] {
  return signals.map((s) => {
    let bucket: "core" | "optional" | "ignore";
    if (s.total_score >= coreMin) bucket = "core";
    else if (s.total_score >= 30) bucket = "optional";
    else bucket = "ignore";
    return { ...s, bucket };
  });
}

export function signalsToStructuredGroups(signals: IngredientSignal[]): {
  core: StructuredIngredient[];
  optional: StructuredIngredient[];
} {
  const core: StructuredIngredient[] = [];
  const optional: StructuredIngredient[] = [];
  const seenCore = new Set<string>();
  const seenOpt = new Set<string>();

  for (const s of signals) {
    if (s.bucket === "ignore") continue;
    const ing = coerceStructuredIngredient(s.best_line);
    if (!ing.name && !ing.original) continue;
    const canonicalName =
      normalizeIngredientName(s.name) || normalizeIngredientName(ing.name || ing.original || "") || s.name;
    const k = canonicalName.toLowerCase();
    if (!k || k.length < 2) continue;
    ing.name = canonicalName;
    ing.unit = normalizeUnit(ing.unit || "") || ing.unit;
    ing.original = (ing.original || s.best_line).replace(
      /\s*(see blog|see recipe|note\s*\d+)\s*$/i,
      ""
    ).trim();

    if (s.bucket === "core") {
      if (seenCore.has(k)) continue;
      seenCore.add(k);
      core.push(ing);
    } else {
      if (seenCore.has(k) || seenOpt.has(k)) continue;
      seenOpt.add(k);
      optional.push(ing);
    }
  }

  return { core: core.slice(0, 14), optional: optional.slice(0, 16) };
}

export type IngredientSignalSnapshot = {
  name: string;
  total_score: number;
  anchor_match: boolean;
  bucket: string;
  frequency: number;
};

export function signalsToSnapshots(signals: IngredientSignal[]): IngredientSignalSnapshot[] {
  return signals
    .filter((s) => s.bucket !== "ignore")
    .map((s) => ({
      name: s.name,
      total_score: s.total_score,
      anchor_match: s.anchor_match,
      bucket: s.bucket,
      frequency: s.frequency,
    }));
}

export function computeIngredientScoreDiffNotes(
  prev: IngredientSignalSnapshot[] | null | undefined,
  next: IngredientSignalSnapshot[]
): string[] {
  const notes: string[] = [];
  if (!prev?.length) {
    for (const s of next.slice(0, 4)) {
      if (s.bucket === "core")
        notes.push(`${s.name}: core (score ${s.total_score})`);
    }
    return notes.slice(0, 5);
  }
  const prevMap = new Map(
    prev.map((p) => [normalizeIngredientName(p.name).toLowerCase(), p])
  );
  const nextMap = new Map(
    next.map((p) => [normalizeIngredientName(p.name).toLowerCase(), p])
  );

  for (const [k, n] of Array.from(nextMap.entries())) {
    const p = prevMap.get(k);
    if (!p) {
      if (n.bucket === "optional")
        notes.push(`${n.name} added as optional (importance ${n.total_score})`);
      else if (n.bucket === "core")
        notes.push(`${n.name} now core (importance ${n.total_score})`);
      continue;
    }
    if (p.bucket !== n.bucket) {
      if (n.bucket === "core" && p.bucket === "optional")
        notes.push(
          `${n.name} importance increased (${p.total_score}→${n.total_score}, now core)`
        );
      else if (n.bucket === "optional" && p.bucket === "core")
        notes.push(
          `${n.name} moved to optional (${p.total_score}→${n.total_score})`
        );
    } else if (Math.abs(n.total_score - p.total_score) >= 12) {
      notes.push(
        `${n.name} score ${p.total_score}→${n.total_score} (${n.bucket})`
      );
    }
  }

  const removed = Array.from(prevMap.keys()).filter((k) => !nextMap.has(k));
  if (removed.length >= 2)
    notes.push(`Consolidated or removed duplicate ingredient lines`);

  return Array.from(new Set(notes)).slice(0, 6);
}
