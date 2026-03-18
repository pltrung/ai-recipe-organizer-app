/**
 * AI pass: re-split flat deduped ingredients into core vs optional (judgment, not frequency).
 * Safe fallback preserves original groups on any failure.
 */

import type { StructuredIngredient } from "./types";
import {
  dedupeIngredientList,
  normalizeAndDedupeGroups,
  normalizeIngredientName,
  normalizeUnit,
} from "./ingredientNormalize";
import { formatQuantity } from "./ingredientScale";

function validationOk(
  core: StructuredIngredient[],
  optional: StructuredIngredient[],
  minTotal: number
): { ok: boolean; reason: string } {
  const seen = new Set<string>();
  for (const c of core) {
    const k = `${normalizeUnit(c.unit)}|${normalizeIngredientName(c.name)}`;
    if (seen.has(k)) return { ok: false, reason: "Duplicate in core after refine." };
    seen.add(k);
  }
  if (minTotal >= 4 && core.length === 0) {
    return { ok: false, reason: "Core empty but recipe has several ingredients." };
  }
  return { ok: true, reason: "" };
}

export async function semanticRefineIngredientGroups(
  dishTitle: string,
  core: StructuredIngredient[],
  optional: StructuredIngredient[],
  openaiApiKey: string
): Promise<{ core: StructuredIngredient[]; optional: StructuredIngredient[] } | null> {
  if (!openaiApiKey?.trim()) return null;

  const flat = dedupeIngredientList([...(core || []), ...(optional || [])]);
  if (flat.length === 0) return null;

  const payload = flat.map((i, idx) => ({
    id: idx,
    quantity: i.quantity,
    unit: i.unit,
    name: i.name,
    original: i.original,
  }));

  const system = `You are a professional chef. Given a dish title and a flat list of ingredients (already deduplicated), split each into:
- core: essential for an authentic, correct version of the dish
- optional: garnishes, enhancements, nice-to-haves

Rules:
- Use culinary knowledge of the dish — NOT frequency or list order.
- Every input id must appear exactly once in either core or optional.
- Preserve quantity, unit, name, original on each item.

Return STRICT JSON:
{ "core_ids": number[], "optional_ids": number[] }

Both arrays must partition all ids 0..n-1 with no overlap.`;

  const run = async (extra?: string) => {
    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const user = `Dish: ${dishTitle}\n\nIngredients (JSON):\n${JSON.stringify(payload).slice(0, 12000)}${extra ? `\n\nFix: ${extra}` : ""}`;
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });
    return completion.choices[0]?.message?.content ?? "";
  };

  try {
    let raw = await run();
    let p = JSON.parse(raw) as { core_ids?: number[]; optional_ids?: number[] };
    const build = (ids: number[] | undefined, all: typeof payload) =>
      (ids ?? [])
        .filter((id) => id >= 0 && id < all.length)
        .map((id) => {
          const row = all[id]!;
          return {
            quantity: row.quantity,
            unit: row.unit,
            name: row.name,
            original:
              row.original?.trim() ||
              [
                row.quantity != null ? formatQuantity(row.quantity) : "",
                row.unit,
                row.name,
              ]
                .filter(Boolean)
                .join(" ")
                .trim() ||
              row.name,
          } as StructuredIngredient;
        });

    let coreOut = build(p.core_ids, payload);
    let optOut = build(p.optional_ids, payload);
    const covered = new Set([...(p.core_ids || []), ...(p.optional_ids || [])]);
    for (let i = 0; i < payload.length; i++) {
      if (!covered.has(i)) {
        optOut = [
          ...optOut,
          {
            quantity: payload[i].quantity,
            unit: payload[i].unit,
            name: payload[i].name,
            original: payload[i].original || payload[i].name,
          },
        ];
      }
    }

    let v = validationOk(coreOut, optOut, flat.length);
    if (!v.ok) {
      raw = await run(v.reason);
      p = JSON.parse(raw) as { core_ids?: number[]; optional_ids?: number[] };
      coreOut = build(p.core_ids, payload);
      optOut = build(p.optional_ids, payload);
      const covered2 = new Set([...(p.core_ids || []), ...(p.optional_ids || [])]);
      for (let i = 0; i < payload.length; i++) {
        if (!covered2.has(i)) {
          optOut.push({
            quantity: payload[i].quantity,
            unit: payload[i].unit,
            name: payload[i].name,
            original: payload[i].original || payload[i].name,
          });
        }
      }
      v = validationOk(coreOut, optOut, flat.length);
    }

    if (core.length > 0 && coreOut.length === 0) {
      return null;
    }

    return { core: coreOut, optional: optOut };
  } catch (e) {
    console.error("[ingredientSemanticRefine]", e);
    return null;
  }
}

export async function applyIngredientPostProcess<T extends {
  title: string;
  ingredients: { core: StructuredIngredient[]; optional: StructuredIngredient[] };
}>(payload: T, openaiKey: string): Promise<T> {
  let { core, optional } = normalizeAndDedupeGroups(payload.ingredients);
  if (!openaiKey?.trim()) {
    return { ...payload, ingredients: { core, optional } };
  }
  const refined = await semanticRefineIngredientGroups(
    payload.title,
    core,
    optional,
    openaiKey
  );
  if (refined) {
    core = dedupeIngredientList(refined.core);
    optional = dedupeIngredientList(refined.optional);
  }
  return { ...payload, ingredients: { core, optional } };
}
