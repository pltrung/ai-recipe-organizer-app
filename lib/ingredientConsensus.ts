/**
 * Cross-source ingredient consensus before Phase C.
 * Clusters raw lines by normalized name; scores by frequency + confidence weights.
 */

import type { SourceConfidence } from "./sourceSynthesisConfidence";
import { normalizeIngredientName } from "./ingredientNormalize";

export type IngredientConsensusRow = {
  name: string;
  frequency: number;
  weighted_score: number;
  sources: number[];
  confidence_levels: string[];
  /** Representative raw lines (trimmed) */
  sample_lines: string[];
};

const CONF_WEIGHT: Record<SourceConfidence, number> = {
  high: 4,
  medium_high: 3,
  medium: 2,
  low: 1,
};

/** Strip leading qty/unit blob for clustering key */
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

function anchorMatch(normalizedStem: string, anchors: string[]): boolean {
  const n = normalizedStem.toLowerCase();
  if (n.length < 3) return false;
  for (const a of anchors) {
    const an = normalizeIngredientName(a).toLowerCase();
    if (!an) continue;
    if (n.includes(an) || an.includes(n)) return true;
    const aw = an.split(/\s+/).filter((w) => w.length > 3);
    if (aw.some((w) => n.includes(w))) return true;
  }
  return false;
}

export function buildIngredientConsensus(
  numbered: {
    id: number;
    line: string;
    sourceIndex: number;
    sourceConf: SourceConfidence;
  }[],
  playbookAnchors: string[],
  essentialIngredients: string[]
): IngredientConsensusRow[] {
  void playbookAnchors;
  void essentialIngredients;

  type Acc = {
    stem: string;
    displayName: string;
    /** sourceIndex -> best confidence for this cluster */
    sourceConf: Map<number, SourceConfidence>;
    weight: number;
    lines: string[];
  };
  const map = new Map<string, Acc>();

  for (const row of numbered) {
    const stem = stemForCluster(row.line);
    const key = stem || cleaningKey(row.line);
    if (!key) continue;
    const w = CONF_WEIGHT[row.sourceConf] ?? 2;
    let acc = map.get(key);
    if (!acc) {
      acc = {
        stem: key,
        displayName: stem || key,
        sourceConf: new Map(),
        weight: 0,
        lines: [],
      };
      map.set(key, acc);
    }
    const prev = acc.sourceConf.get(row.sourceIndex);
    const prevW = prev ? CONF_WEIGHT[prev] : 0;
    if (!prev || w > prevW) acc.sourceConf.set(row.sourceIndex, row.sourceConf);
    acc.weight += w;
    if (acc.lines.length < 4 && row.line.trim()) acc.lines.push(row.line.trim());
  }

  const rows: IngredientConsensusRow[] = [];
  for (const acc of Array.from(map.values())) {
    const sources = Array.from(acc.sourceConf.keys()).sort(
      (a: number, b: number) => a - b
    );
    const confidence_levels = sources.map((si) => acc.sourceConf.get(si)!);
    rows.push({
      name: acc.displayName,
      frequency: sources.length,
      weighted_score: Math.round(acc.weight * 10) / 10,
      sources,
      confidence_levels,
      sample_lines: acc.lines,
    });
  }

  rows.sort((a, b) => b.weighted_score - a.weighted_score || b.frequency - a.frequency);
  return rows;
}

/** Sources that count as "strong" for multi-source core rule */
function isStrongConf(c: string): boolean {
  return c === "high" || c === "medium_high" || c === "medium";
}

/** Heuristic: should be treated as core candidate from consensus alone */
export function consensusSuggestsCore(
  row: IngredientConsensusRow,
  anchors: string[]
): boolean {
  let strongSourceCount = 0;
  for (let i = 0; i < row.sources.length; i++) {
    if (isStrongConf(row.confidence_levels[i] ?? "")) strongSourceCount++;
  }
  const appears2StrongSources = strongSourceCount >= 2;
  const onlyLow =
    row.confidence_levels.length > 0 &&
    row.confidence_levels.every((c) => c === "low");
  const anchor = anchorMatch(row.name, anchors);

  if (anchor) return true;
  if (onlyLow && row.frequency <= 1) return false;
  return appears2StrongSources || (row.weighted_score >= 6 && row.frequency >= 2);
}

/**
 * Compact block for Phase C — model must align core/optional with consensus + anchors.
 */
export function formatConsensusForPhaseC(
  rows: IngredientConsensusRow[],
  anchors: string[]
): string {
  const lines: string[] = [
    "INGREDIENT CONSENSUS (cross-source; use for core vs optional):",
    "— CORE bias: ≥2 sources with high/medium confidence OR matches dish-essential/playbook anchor.",
    "— OPTIONAL bias: single source only low confidence, unless anchor.",
    "",
  ];
  const top = rows.slice(0, 45);
  for (const r of top) {
    const coreHint = consensusSuggestsCore(r, anchors) ? " → lean CORE" : " → lean OPTIONAL";
    lines.push(
      `• ${r.name} | freq=${r.frequency} src=[${r.sources.join(",")}] score=${r.weighted_score} | ${r.confidence_levels.join(",")}${coreHint}`
    );
    if (r.sample_lines[0]) lines.push(`  e.g. ${r.sample_lines[0]!.slice(0, 100)}`);
  }
  if (anchors.length) {
    lines.push("");
    lines.push(`PLAYBOOK/ESSENTIAL ANCHORS (must land in core if present in candidates): ${anchors.slice(0, 16).join("; ")}`);
  }
  return lines.join("\n");
}
