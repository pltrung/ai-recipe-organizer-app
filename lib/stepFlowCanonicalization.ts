/**
 * Pre–Phase D: collapse multi-source step_candidates into ONE dominant cooking flow.
 */

import type { SourceConfidence } from "./sourceSynthesisConfidence";
import type { StructuredIngredient } from "./types";

const MODEL = "gpt-4o-mini";

/** Coarse action bucket for dedupe / validation (shared with Phase D cleanup). */
export function stepActionFingerprint(text: string): string {
  const low = text.toLowerCase();
  if (/\bdeep[\s-]?fry|fry\s+until|frying\b/.test(low)) return "fry";
  if (/\bmarinat|soak\b/.test(low)) return "marinate";
  if (/\bcoat|dredge|batter|bread\b/.test(low)) return "coat";
  if (/\bheat\s+oil|oil\s+to\s+\d/.test(low)) return "heat_oil";
  if (/\bdrain|rest\b/.test(low) && /\d+\s*(min|hour)/.test(low)) return "rest_drain";
  if (/\bsauce|simmer\s+sauce/.test(low)) return "sauce";
  if (/\bserve|garnish|plate\b/.test(low)) return "serve";
  if (/\bmix|combine|whisk\b/.test(low)) return "mix";
  if (/\bpreheat|oven\b/.test(low)) return "oven";
  return "other";
}

export type CanonicalStage = {
  stage: string;
  action_summary: string;
  supporting_lines: string[];
};

export type CanonicalStepPlan = {
  dominant_flow: { stages: CanonicalStage[] };
  discarded_or_secondary_flows: string[];
  tip_candidates: string[];
  warning_candidates: string[];
  variant_candidates: string[];
};

type TaggedLine = {
  line: string;
  sourceIdx: number;
  conf: SourceConfidence;
  weight: number;
};

function confWeight(c: SourceConfidence): number {
  if (c === "high") return 4;
  if (c === "medium_high") return 3;
  if (c === "medium") return 2;
  return 1;
}

function tokenSet(s: string): Set<string> {
  const m = s.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  return new Set(m.filter((w) => w.length > 2 && !STOP.has(w)));
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "your",
  "then",
  "until",
  "about",
  "some",
]);

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of Array.from(a)) {
    if (b.has(x)) inter++;
  }
  const u = a.size + b.size - inter;
  return u ? inter / u : 0;
}

/** Group lines for clustering: marinate / fry / prep / assemble / other */
export function actionPhaseBucket(line: string): "marinate" | "fry" | "prep" | "assemble" | "other" {
  const low = line.toLowerCase();
  if (/\bmarinat|soak\b|brine|overnight in fridge|rest \d+\s*h/.test(low))
    return "marinate";
  if (/\b(deep[\s-]?)?fry|frying|shallow fry|until golden and crisp|crispy in oil/.test(low))
    return "fry";
  if (/\bserve|garnish|plate|divide among|top with|final layer|dust with cocoa/.test(low))
    return "assemble";
  if (
    /\bpreheat|mix|combine|whisk|chop|slice|dice|coat|dredge|heat (the )?oil|drain on|rest \d+\s*min|knead|proof|roll|stretch|simmer (the )?broth|boil|bake|layer|dip ladyfinger|whip|fold in/.test(
      low
    )
  )
    return "prep";
  return "other";
}

const LEADING_SCAFFOLD =
  /^\s*(to\s+(marinate|fry|bake|simmer|cook|prep|prepare|make|assemble|chill|rest|serve|mix)\s*[:,]?\s*|for\s+the\s+(sauce|marinade|dressing|gravy|dip|broth|batter|coating)\s*[:,]?\s*|before\s+(you\s+)?(start|begin)\s*[:,]?\s*)/i;

export function stripSourceScaffoldingLine(line: string): string {
  let s = line.trim();
  s = s.replace(LEADING_SCAFFOLD, "").trim();
  return s || line.trim();
}

/** Cluster similar procedural lines; prefer merging within same action phase. */
export function clusterStepCandidates(tagged: TaggedLine[]): {
  clusterId: string;
  representative: string;
  lines: TaggedLine[];
  sourceWeights: Map<number, number>;
}[] {
  const clusters: {
    representative: string;
    lines: TaggedLine[];
    tokens: Set<string>;
    bucket: ReturnType<typeof actionPhaseBucket>;
  }[] = [];

  for (const t of tagged) {
    const cleanLine = stripSourceScaffoldingLine(t.line);
    const tAdj = { ...t, line: cleanLine.length >= 8 ? cleanLine : t.line };
    const tok = tokenSet(tAdj.line);
    const buck = actionPhaseBucket(tAdj.line);
    let best = -1;
    let bestJ = 0;
    for (let i = 0; i < clusters.length; i++) {
      const j = jaccard(tok, clusters[i]!.tokens);
      const sameB = buck === clusters[i]!.bucket && buck !== "other";
      const thresh = sameB ? 0.28 : 0.4;
      if (j >= thresh && j > bestJ) {
        bestJ = j;
        best = i;
      }
    }
    if (best >= 0 && bestJ >= 0.28) {
      clusters[best]!.lines.push(tAdj);
      for (const w of Array.from(tok)) clusters[best]!.tokens.add(w);
      if (tAdj.line.length > clusters[best]!.representative.length)
        clusters[best]!.representative = tAdj.line;
    } else {
      clusters.push({
        representative: tAdj.line,
        lines: [tAdj],
        tokens: new Set(tok),
        bucket: buck,
      });
    }
  }

  return clusters.map((c, i) => {
    const sourceWeights = new Map<number, number>();
    for (const ln of c.lines) {
      const w = ln.weight * (1 + 0.1 * ln.line.length / 200);
      sourceWeights.set(
        ln.sourceIdx,
        (sourceWeights.get(ln.sourceIdx) ?? 0) + w
      );
    }
    return {
      clusterId: `K${i + 1}`,
      representative: c.representative.slice(0, 320),
      lines: c.lines,
      sourceWeights,
    };
  });
}

function scoreSourceForFlow(tagged: TaggedLine[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of tagged) {
    m.set(t.sourceIdx, (m.get(t.sourceIdx) ?? 0) + t.weight);
  }
  return m;
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
        { role: "user", content: user.slice(0, 95_000) },
      ],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    console.error("[canonical-flow] chatJson", e);
    return null;
  }
}

function parsePlan(raw: Record<string, unknown> | null): CanonicalStepPlan | null {
  if (!raw) return null;
  const df = raw.dominant_flow as Record<string, unknown> | undefined;
  const stagesRaw = df?.stages;
  if (!Array.isArray(stagesRaw) || stagesRaw.length === 0) return null;
  const stages: CanonicalStage[] = [];
  for (const s of stagesRaw) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const stage = String(o.stage ?? "").trim().slice(0, 80);
    const action_summary = String(o.action_summary ?? "").trim().slice(0, 500);
    const sup = Array.isArray(o.supporting_lines)
      ? (o.supporting_lines as unknown[])
          .map((x) => String(x).trim())
          .filter(Boolean)
          .slice(0, 8)
      : [];
    if (!action_summary && !stage) continue;
    stages.push({
      stage: stage || `Stage ${stages.length + 1}`,
      action_summary: action_summary || stage,
      supporting_lines: sup,
    });
  }
  if (stages.length === 0) return null;
  const strArr = (k: string, max: number) =>
    Array.isArray(raw[k])
      ? (raw[k] as unknown[]).map((x) => String(x).trim()).filter(Boolean).slice(0, max)
      : [];
  return sanitizeCanonicalPlan({
    dominant_flow: { stages: stages.slice(0, 12) },
    discarded_or_secondary_flows: strArr("discarded_or_secondary_flows", 14),
    tip_candidates: strArr("tip_candidates", 14),
    warning_candidates: strArr("warning_candidates", 10),
    variant_candidates: strArr("variant_candidates", 10),
  });
}

export function sanitizeCanonicalPlan(plan: CanonicalStepPlan): CanonicalStepPlan {
  const s = (x: string) =>
    stripSourceScaffoldingLine(x).replace(/\s+/g, " ").trim().slice(0, 500);
  return {
    dominant_flow: {
      stages: plan.dominant_flow.stages.map((st) => ({
        stage: (s(st.stage).slice(0, 80) || "Cook").replace(/^[,;:\s]+/, ""),
        action_summary: s(st.action_summary) || s(st.stage) || "Continue recipe.",
        supporting_lines: st.supporting_lines
          .map((l) => s(l))
          .filter((l) => l.length > 6)
          .slice(0, 8),
      })),
    },
    discarded_or_secondary_flows: plan.discarded_or_secondary_flows
      .map(s)
      .filter(Boolean)
      .slice(0, 14),
    tip_candidates: plan.tip_candidates.map(s).filter(Boolean).slice(0, 14),
    warning_candidates: plan.warning_candidates.map(s).filter(Boolean).slice(0, 10),
    variant_candidates: plan.variant_candidates.map(s).filter(Boolean).slice(0, 10),
  };
}

export type CanonicalizeResult = {
  plan: CanonicalStepPlan;
  rawCandidateCount: number;
  clusterCount: number;
  secondaryFlowItemCount: number;
  usedLlmPlan: boolean;
};

/** When LLM fails: one timeline from highest-weight source lines in playbook order. */
export function fallbackCanonicalPlan(
  tagged: TaggedLine[],
  expectedFlow: string[],
  clusters: ReturnType<typeof clusterStepCandidates>
): CanonicalStepPlan {
  const srcScores = scoreSourceForFlow(tagged);
  let bestSrc = 0;
  let bestW = -1;
  for (const [si, w] of Array.from(srcScores.entries())) {
    if (w > bestW) {
      bestW = w;
      bestSrc = si;
    }
  }
  const primaryLines = tagged
    .filter((t) => t.sourceIdx === bestSrc)
    .map((t) => t.line);
  const secondary = tagged
    .filter((t) => t.sourceIdx !== bestSrc)
    .slice(0, 12)
    .map((t) => `[Other source] ${t.line}`);

  if (expectedFlow.length >= 4) {
    const stages: CanonicalStage[] = expectedFlow.slice(0, 10).map((ef, i) => {
      const efTok = tokenSet(ef);
      const support = clusters
        .filter((cl) => {
          const ct = tokenSet(cl.representative);
          return jaccard(efTok, ct) >= 0.12 || cl.lines.some((ln) => jaccard(efTok, tokenSet(ln.line)) >= 0.12);
        })
        .flatMap((cl) =>
          cl.lines
            .filter((ln) => ln.sourceIdx === bestSrc || cl.lines.length < 4)
            .map((ln) => ln.line)
        );
      const uniq = Array.from(new Set(support)).slice(0, 6);
      return {
        stage: ef.slice(0, 60),
        action_summary: primaryLines[i] ?? ef,
        supporting_lines: uniq.length ? uniq : primaryLines.slice(i, i + 2),
      };
    });
    return sanitizeCanonicalPlan({
      dominant_flow: { stages },
      discarded_or_secondary_flows: secondary.slice(0, 8),
      tip_candidates: [],
      warning_candidates: [],
      variant_candidates: [],
    });
  }

  const stages: CanonicalStage[] = [];
  const chunk = Math.max(1, Math.ceil(primaryLines.length / 7));
  for (let i = 0; i < primaryLines.length && stages.length < 9; i += chunk) {
    const slice = primaryLines.slice(i, i + chunk);
    stages.push({
      stage: `Cooking phase ${stages.length + 1}`,
      action_summary: slice.join(" Then "),
      supporting_lines: slice.slice(1),
    });
  }
  if (stages.length === 0 && expectedFlow.length) {
    return sanitizeCanonicalPlan(fallbackCanonicalFromExpectedFlow(expectedFlow));
  }
  return sanitizeCanonicalPlan({
    dominant_flow: { stages },
    discarded_or_secondary_flows: secondary.slice(0, 8),
    tip_candidates: [],
    warning_candidates: [],
    variant_candidates: [],
  });
}

export function fallbackCanonicalFromExpectedFlow(
  expectedFlow: string[]
): CanonicalStepPlan {
  return sanitizeCanonicalPlan({
    dominant_flow: {
      stages: expectedFlow.slice(0, 10).map((line, i) => ({
        stage: line.slice(0, 50),
        action_summary: line,
        supporting_lines: [] as string[],
      })),
    },
    discarded_or_secondary_flows: [],
    tip_candidates: [],
    warning_candidates: [],
    variant_candidates: [],
  });
}

/** Guarantees ≥3 stages so Phase D always has a spine (merge/create must not fail on empty playbook edge cases). */
export function ensureCanonicalPlanHasStages(
  plan: CanonicalStepPlan,
  expectedFlow: string[],
  dishName: string
): CanonicalStepPlan {
  if (plan.dominant_flow.stages.length >= 3) return plan;
  if (expectedFlow.length >= 3) return fallbackCanonicalFromExpectedFlow(expectedFlow);
  const dn = dishName.trim().slice(0, 50) || "the dish";
  return fallbackCanonicalFromExpectedFlow([
    `Combine and prep components for ${dn}`,
    "Cook using the main method until done (timing per ingredients)",
    "Finish, rest if needed, and serve",
  ]);
}

export function formatCanonicalPlanForPhaseD(plan: CanonicalStepPlan): string {
  const lines: string[] = [];
  let i = 0;
  for (const st of plan.dominant_flow.stages) {
    i++;
    lines.push(
      `STAGE ${i} — ${st.stage}\nPRIMARY ACTION: ${st.action_summary}`
    );
    if (st.supporting_lines.length) {
      lines.push(
        `Supporting detail (may fold into this step, not a separate recipe): ${st.supporting_lines.join(" | ")}`
      );
    }
  }
  lines.push(
    "\nYou MUST write ONE linear recipe: each final step maps to these stages in order. Do NOT duplicate the full sequence. Do NOT add a second complete method."
  );
  return lines.join("\n\n");
}

export type CanonicalizeInput = {
  extractions: { step_candidates: string[]; tip_candidates?: string[] }[];
  chunks: { confidence?: SourceConfidence }[];
  expectedFlow: string[];
  dishFamily: string;
  dishName: string;
  coreIngredients: StructuredIngredient[];
  /** Short summary e.g. "3 sources: 2 high, 1 low" */
  confidenceSummary: string;
};

export async function canonicalizeStepFlow(
  openai: InstanceType<typeof import("openai").default>,
  input: CanonicalizeInput
): Promise<CanonicalizeResult> {
  const tagged: TaggedLine[] = [];
  for (let i = 0; i < input.extractions.length; i++) {
    const conf = input.chunks[i]?.confidence ?? "medium";
    const w = confWeight(conf);
    const sc = input.extractions[i]!.step_candidates ?? [];
    for (const line of sc) {
      const t = String(line).trim();
      if (t.length < 8 || t.length > 600) continue;
      tagged.push({ line: t, sourceIdx: i, conf, weight: w });
    }
  }

  const rawCount = tagged.length;
  if (rawCount === 0) {
    const plan = fallbackCanonicalFromExpectedFlow(input.expectedFlow);
    const sec = 0;
    return {
      plan,
      rawCandidateCount: 0,
      clusterCount: 0,
      secondaryFlowItemCount: sec,
      usedLlmPlan: false,
    };
  }

  const clusters = clusterStepCandidates(tagged);
  const clusterBlock = clusters
    .map((c) => {
      const srcs = Array.from(c.sourceWeights.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([si, sc]) => `S${si}:${sc.toFixed(1)}`)
        .join(" ");
      return `[${c.clusterId}] weight_by_source ${srcs}\nREP: ${c.representative}\nALL: ${c.lines.map((l) => `(S${l.sourceIdx}/${l.conf}) ${l.line.slice(0, 200)}`).join("\n")}`;
    })
    .join("\n\n");

  const coreNames = input.coreIngredients
    .map((c) => c.name || c.original)
    .filter(Boolean)
    .slice(0, 24)
    .join(", ");
  const flowLines = input.expectedFlow.map((s, j) => `${j + 1}. ${s}`).join("\n");

  const system = `You collapse MULTIPLE recipe sources into ONE canonical cooking timeline for a single final recipe.

Rules:
- dominant_flow.stages: 5–9 stages (hard max 10). ONE continuous method only.
- When sources disagree (e.g. air-fry vs deep-fry, two marinade times), pick the DOMINANT method: prefer higher source weights in each cluster block. Put the other method in variant_candidates or discarded_or_secondary_flows — NEVER as a parallel full flow.
- Each stage: short stage label + action_summary (one imperative paragraph) + supporting_lines (fragments merged into that beat only).
- NEVER start stage or action_summary with "To marinate", "To fry", "For the sauce", "Before you start" — use direct imperatives.
- dominant_flow must cover the CORE INGREDIENTS across stages where logically needed (marinate includes protein+aromatics, fry includes coated protein+oil, etc.).
- Do NOT output two full fry-then-serve sequences. Do NOT preserve blog section structure.
- tip_candidates: optional timing/texture tweaks.
- warning_candidates: safety/quality from demoted flows.
- variant_candidates: "Alternatively…" one-liners.
- discarded_or_secondary_flows: brief descriptions of rejected alternate timelines.

Return STRICT JSON:
{
  "dominant_flow": { "stages": [ { "stage": string, "action_summary": string, "supporting_lines": string[] } ] },
  "discarded_or_secondary_flows": string[],
  "tip_candidates": string[],
  "warning_candidates": string[],
  "variant_candidates": string[]
}`;

  const user = `DISH: ${input.dishName} | family: ${input.dishFamily}
SOURCE CONFIDENCE SUMMARY: ${input.confidenceSummary}
EXPECTED_FLOW (follow this order; merge beats):
${flowLines}

CORE INGREDIENTS: ${coreNames}

CLUSTERED STEP CANDIDATES (similar lines grouped; S# = source index, weights show reliability):
${clusterBlock.slice(0, 88_000)}`;

  const raw = await chatJson(openai, system, user);
  let plan = parsePlan(raw);
  let usedLlm = Boolean(plan && plan.dominant_flow.stages.length >= 3);

  if (!plan || plan.dominant_flow.stages.length < 3) {
    plan = fallbackCanonicalPlan(tagged, input.expectedFlow, clusters);
    usedLlm = false;
  }

  const secondaryCount =
    plan.discarded_or_secondary_flows.length +
    plan.tip_candidates.length +
    plan.warning_candidates.length +
    plan.variant_candidates.length;

  return {
    plan,
    rawCandidateCount: rawCount,
    clusterCount: clusters.length,
    secondaryFlowItemCount: secondaryCount,
    usedLlmPlan: usedLlm,
  };
}

export function buildConfidenceSummary(
  chunks: { confidence?: SourceConfidence }[]
): string {
  const counts: Record<string, number> = {};
  for (const c of chunks) {
    const k = c.confidence ?? "medium";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const parts = Object.entries(counts).map(([k, n]) => `${n} ${k}`);
  return `${chunks.length} source(s): ${parts.join(", ")}`;
}
