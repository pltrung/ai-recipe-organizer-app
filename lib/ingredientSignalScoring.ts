/**
 * Ingredient importance scoring — core vs optional from dish identity, not DOM noise.
 */

import type { SourceConfidence } from "./sourceSynthesisConfidence";
import type { StructuredIngredient } from "./types";
import { coerceStructuredIngredient } from "./ingredientParser";
import { normalizeIngredientName, normalizeUnit } from "./ingredientNormalize";
import {
  anchorLineSatisfiedInCore,
  type MaterializedAnchor,
} from "./dishAnchors";

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

function stemForCluster(line: string): string {
  const t = line.trim();
  if (!t) return "";
  const stripped = t.replace(
    /^[\d./\s-]+(?:\d+\/\d+)?\s*(?:tbsp|tsp|tablespoons?|teaspoons?|cups?|oz|lb|lbs|g|kg|ml|l|cloves?|pieces?|large|medium|small)?\.?\s*/i,
    ""
  );
  const blob = (stripped || t).slice(0, 120);
  return normalizeIngredientName(blob) || cleaningKey(blob);
}

function cleaningKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s\u00C0-\u024F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
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

function clusterMatchesMaterialized(
  lines: string[],
  materialized: MaterializedAnchor[]
): boolean {
  for (const { line: anchorLine } of materialized) {
    for (const ln of lines) {
      const ing = coerceStructuredIngredient(ln);
      if (anchorLineSatisfiedInCore([ing], anchorLine)) return true;
    }
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

export function buildIngredientSignals(
  numbered: {
    line: string;
    sourceIndex: number;
    sourceConf: SourceConfidence;
  }[],
  roleByLine: Map<string, string>,
  dishAnchorTokens: string[],
  materialized: MaterializedAnchor[],
  coreScoreMin = 70
): IngredientSignal[] {
  type Acc = {
    key: string;
    displayName: string;
    sourceConf: Map<number, SourceConfidence>;
    lines: string[];
  };
  const map = new Map<string, Acc>();

  for (const row of numbered) {
    const stem = stemForCluster(row.line);
    const key = stem || cleaningKey(row.line);
    if (!key) continue;
    let acc = map.get(key);
    if (!acc) {
      acc = {
        key,
        displayName: stem || key,
        sourceConf: new Map(),
        lines: [],
      };
      map.set(key, acc);
    }
    const prev = acc.sourceConf.get(row.sourceIndex);
    const prevW = prev ? CONF_TO_SCORE[prev] ?? 50 : 0;
    const w = CONF_TO_SCORE[row.sourceConf] ?? 50;
    if (!prev || w > prevW) acc.sourceConf.set(row.sourceIndex, row.sourceConf);
    if (acc.lines.length < 6 && row.line.trim()) acc.lines.push(row.line.trim());
  }

  const anchorTokens = [
    ...dishAnchorTokens,
    ...materialized.map((m) => m.line),
  ].filter(Boolean);

  const signals: IngredientSignal[] = [];
  for (const acc of Array.from(map.values())) {
    const sources = Array.from(acc.sourceConf.keys());
    const confLevels = sources.map((si) => acc.sourceConf.get(si)!);
    const frequency = sources.length;
    const frequency_score = Math.min(100, frequency * 30);
    let confidence_score = 0;
    for (const c of confLevels) {
      confidence_score = Math.max(
        confidence_score,
        CONF_TO_SCORE[c] ?? 50
      );
    }

    let bestRoleScore = 0;
    let bestRole = "flavor";
    for (const ln of acc.lines) {
      const r = lookupRole(ln, roleByLine);
      const rs = roleScore(r);
      if (rs > bestRoleScore) {
        bestRoleScore = rs;
        bestRole = r;
      }
    }

    const anchor_match =
      clusterMatchesMaterialized(acc.lines, materialized) ||
      anchorTokenMatch(acc.displayName, anchorTokens);

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

    let pickLine = acc.lines[0] || acc.displayName;
    let bestConf = -1;
    for (const ln of acc.lines) {
      const rows = numbered.filter((n) => n.line === ln);
      const sc = rows.length
        ? Math.max(...rows.map((r) => CONF_TO_SCORE[r.sourceConf] ?? 0))
        : 0;
      if (sc > bestConf) {
        bestConf = sc;
        pickLine = ln;
      }
    }

    signals.push({
      name: acc.displayName,
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
    const k = normalizeIngredientName(ing.name || ing.original || "").toLowerCase();
    if (!k || k.length < 2) continue;
    ing.name = normalizeIngredientName(ing.name || ing.original || s.name);
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
