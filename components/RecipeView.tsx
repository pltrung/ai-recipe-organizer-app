"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Recipe,
  RecipeLastDiff,
  RecipeStep,
  ScaledIngredient,
  StructuredIngredient,
} from "@/lib/types";
import {
  dedupeIngredientList,
  normalizeIngredientName,
  sortIngredientsByRole,
} from "@/lib/ingredientNormalize";
import {
  formatQuantity,
  formatScaledLine,
  scaleIngredients,
} from "@/lib/ingredientScale";
import { RecipeUpdatedModal } from "@/components/RecipeUpdatedModal";

const EMPTY_ING: StructuredIngredient[] = [];

type RecipeViewProps = {
  recipe: Recipe;
  sourceCount?: number;
  needsUserInput?: boolean;
  needsReview?: boolean;
  lastDiff?: RecipeLastDiff | null;
  onEdit?: () => void;
  onSave?: () => void;
  onDuplicate?: () => void;
};

function formatTaxonomyLabel(t: string): string {
  return String(t || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function IngredientCardRow({
  ing,
  scaled,
  showScaled,
  coreRationale,
}: {
  ing: StructuredIngredient;
  scaled: ScaledIngredient;
  showScaled: boolean;
  coreRationale?: string;
}) {
  const canScale =
    scaled.scaledQuantity != null && Boolean(ing.unit) && ing.quantity != null;
  const useScaled = showScaled && canScale;
  const qty = useScaled
    ? scaled.scaledQuantity
    : ing.quantity;
  const qtyStr =
    qty != null && !Number.isNaN(qty) ? formatQuantity(qty) : null;
  const unit = (ing.unit || "").trim();
  const name = (ing.name || "").trim() || ing.original?.trim() || "—";

  const line =
    qtyStr != null && unit
      ? `${qtyStr} ${unit} ${name}`.trim()
      : formatScaledLine({
          ...scaled,
          scaledQuantity: scaled.scaledQuantity,
        });

  const [whyOpen, setWhyOpen] = useState(false);

  return (
    <div className="border-b border-neutral-100 py-3.5 text-[15px] leading-snug last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="font-medium text-neutral-900">{line}</span>
        {coreRationale ? (
          <button
            type="button"
            onClick={() => setWhyOpen((v) => !v)}
            className="shrink-0 text-xs font-medium text-emerald-700 hover:text-emerald-900"
          >
            {whyOpen ? "Hide why" : "Why essential?"}
          </button>
        ) : null}
      </div>
      {whyOpen && coreRationale ? (
        <p className="mt-2 rounded-lg bg-emerald-50/80 px-3 py-2 text-sm leading-relaxed text-emerald-950">
          {coreRationale}
        </p>
      ) : null}
    </div>
  );
}

export function RecipeView({
  recipe,
  sourceCount = 0,
  needsUserInput = false,
  needsReview = false,
  lastDiff,
  onEdit,
  onSave,
  onDuplicate,
}: RecipeViewProps) {
  const coreRaw = recipe.ingredients?.core ?? EMPTY_ING;
  const optionalRaw = recipe.ingredients?.optional ?? EMPTY_ING;
  const steps: RecipeStep[] = Array.isArray(recipe.steps)
    ? (recipe.steps as RecipeStep[]).filter(
        (s) => s && typeof s === "object" && String(s.instructions || "").trim()
      )
    : [];
  const tips = Array.isArray(recipe.tips) ? recipe.tips : [];
  const substitutions = Array.isArray(recipe.substitutions)
    ? recipe.substitutions
    : [];
  const sourceUrls = Array.isArray(recipe.source_urls) ? recipe.source_urls : [];
  const versions = recipe.versions ?? [];
  const quality = recipe.recipe_quality;

  const rationaleByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of quality?.core_rationale ?? []) {
      m.set(normalizeIngredientName(r.name), r.why);
    }
    return m;
  }, [quality?.core_rationale]);

  const core = useMemo(
    () => dedupeIngredientList(coreRaw),
    [coreRaw]
  );
  const optional = useMemo(
    () =>
      sortIngredientsByRole(
        dedupeIngredientList(optionalRaw),
        quality?.ingredient_roles ?? []
      ),
    [optionalRaw, quality?.ingredient_roles]
  );

  const ingTotal = core.length + optional.length;
  const isEmpty = ingTotal === 0 && steps.length === 0;
  const showBuilderCta = needsUserInput || isEmpty;

  const baseServings = Math.max(1, recipe.servings_base ?? 1);
  const [targetServings, setTargetServings] = useState(baseServings);
  const [showScaled, setShowScaled] = useState(true);
  const [diffModalOpen, setDiffModalOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [rationaleOpen, setRationaleOpen] = useState(false);

  const meaningfulSubstitutions = useMemo(() => {
    if (!Array.isArray(substitutions) || substitutions.length === 0) return [];
    return substitutions.filter((sub) => {
      const o = sub && typeof sub === "object" ? sub : null;
      const main = String(o?.ingredient ?? o?.original ?? "").trim();
      if (!main) return false;
      const alts =
        o && Array.isArray(o.options) && o.options.length
          ? o.options
          : o && Array.isArray(o.alternatives)
            ? o.alternatives
            : [];
      const note = o?.note?.trim();
      return alts.length > 0 || Boolean(note);
    });
  }, [substitutions]);

  const showQualityPills =
    (quality?.dish_taxonomy && quality.dish_taxonomy !== "other") ||
    Boolean(quality?.cuisine?.trim()) ||
    (quality?.synthesis_style && quality.synthesis_style !== "authentic");

  const hasQualityBody =
    (quality?.critical_tips?.length ?? 0) > 0 ||
    (quality?.avoid_mistakes?.length ?? 0) > 0 ||
    (quality?.variant_notes?.length ?? 0) > 0 ||
    (quality?.core_rationale?.length ?? 0) > 0;

  useEffect(() => {
    setTargetServings(baseServings);
  }, [baseServings, recipe.id]);

  const scaledCore = useMemo(
    () => scaleIngredients(core, baseServings, targetServings),
    [core, baseServings, targetServings]
  );
  const scaledOptional = useMemo(
    () => scaleIngredients(optional, baseServings, targetServings),
    [optional, baseServings, targetServings]
  );

  const bump = useCallback((d: number) => {
    setTargetServings((n) => Math.min(99, Math.max(1, n + d)));
  }, []);

  const scrollToCooking = () => {
    document.getElementById("recipe-steps")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const nSources = Math.max(
    sourceCount || 0,
    sourceUrls.length,
    recipe.source_platforms?.length ?? 0,
    1
  );

  return (
    <article className="mx-auto max-w-[720px] space-y-6 px-1 sm:px-0">
      {lastDiff?.at && (
        <RecipeUpdatedModal
          lastDiff={lastDiff}
          openWhenPresent={false}
          forceOpen={diffModalOpen}
          onForceClose={() => setDiffModalOpen(false)}
        />
      )}

      {needsReview && (
        <div className="rounded-xl border border-amber-200/90 bg-amber-50 px-5 py-4 text-sm text-amber-950 shadow-sm">
          <strong>Needs review:</strong> A new source was saved, but the recipe
          couldn&apos;t be re-synthesized automatically. Add another source from
          the extension or edit below.
        </div>
      )}

      {lastDiff?.summary && (
        <button
          type="button"
          onClick={() => setDiffModalOpen(true)}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-200/80 bg-gradient-to-r from-emerald-50 to-white px-4 py-3.5 text-sm font-semibold text-emerald-900 shadow-sm transition hover:border-emerald-300 hover:shadow"
        >
          <span aria-hidden>✨</span>
          What changed
        </button>
      )}

      {showBuilderCta && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/90 px-5 py-5 shadow-sm">
          <p className="font-semibold text-amber-950">Keep building</p>
          <p className="mt-2 text-sm leading-relaxed text-amber-900/90">
            Add sources with the Recipe Cloud extension or{" "}
            <Link href="/create" className="font-medium underline underline-offset-2">
              Create
            </Link>
            .
          </p>
        </div>
      )}

      {/* Hero */}
      <header className="space-y-4 pt-2">
        <h1 className="text-4xl font-bold tracking-tight text-neutral-950 sm:text-[2.5rem] sm:leading-tight">
          {recipe.title}
        </h1>
        {recipe.description?.trim() && (
          <p className="text-lg leading-relaxed text-neutral-600">
            {recipe.description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-neutral-600">
          {recipe.estimated_time && recipe.estimated_time !== "—" && (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-neutral-400" aria-hidden>
                ⏱
              </span>
              {recipe.estimated_time}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <span className="text-neutral-400" aria-hidden>
              🍽
            </span>
            {recipe.servings || `${baseServings} servings`}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="text-neutral-400" aria-hidden>
              📚
            </span>
            {nSources} source{nSources === 1 ? "" : "s"}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-neutral-500">
          Your <strong>home base</strong> for this dish — ingredients, steps, and
          notes improve as you add sources from the extension.
        </p>
        {showQualityPills ? (
          <div className="flex flex-wrap gap-2 pt-1">
            {quality?.dish_taxonomy && quality.dish_taxonomy !== "other" ? (
              <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-700">
                {formatTaxonomyLabel(quality.dish_taxonomy)}
              </span>
            ) : null}
            {quality?.cuisine?.trim() ? (
              <span className="rounded-full bg-neutral-100/80 px-3 py-1 text-xs font-medium text-neutral-600">
                {quality.cuisine.trim()}
              </span>
            ) : null}
            {quality?.synthesis_style &&
            quality.synthesis_style !== "authentic" ? (
              <span className="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-600">
                Style:{" "}
                {quality.synthesis_style === "easier_at_home"
                  ? "Easier at home"
                  : quality.synthesis_style === "lighter"
                    ? "Lighter"
                    : "Rich / indulgent"}
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      {hasQualityBody ? (
        <div className="space-y-4">
          {(quality?.critical_tips?.length || quality?.avoid_mistakes?.length) ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {quality.critical_tips && quality.critical_tips.length > 0 ? (
            <section className="rounded-xl border border-blue-200/80 bg-blue-50/60 px-4 py-4 shadow-sm">
              <h2 className="text-xs font-bold uppercase tracking-wide text-blue-900">
                Must know
              </h2>
              <p className="mt-0.5 text-[11px] text-blue-900/65">
                Texture, timing, authenticity — not fluff
              </p>
              <ul className="mt-2 space-y-2 text-sm text-blue-950">
                {quality.critical_tips.map((t, i) => (
                  <li key={i} className="leading-snug">
                    {t}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {quality.avoid_mistakes && quality.avoid_mistakes.length > 0 ? (
            <section className="rounded-xl border border-red-200/80 bg-red-50/50 px-4 py-4 shadow-sm">
              <h2 className="text-xs font-bold uppercase tracking-wide text-red-900">
                Avoid
              </h2>
              <p className="mt-0.5 text-[11px] text-red-900/65">
                Common failures — worth reading once
              </p>
              <ul className="mt-2 space-y-2 text-sm text-red-950">
                {quality.avoid_mistakes.map((t, i) => (
                  <li key={i} className="leading-snug">
                    {t}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}

          {quality?.variant_notes && quality.variant_notes.length > 0 ? (
            <section className="rounded-xl border border-violet-200/70 bg-violet-50/40 px-4 py-4">
              <h2 className="text-xs font-bold uppercase tracking-wide text-violet-900">
                Variants
              </h2>
              <ul className="mt-2 space-y-2 text-sm text-violet-950">
                {quality.variant_notes.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {quality?.core_rationale && quality.core_rationale.length > 0 ? (
            <div className="rounded-lg border border-neutral-200/80 bg-neutral-50/50 px-4 py-3">
              <button
                type="button"
                onClick={() => setRationaleOpen((v) => !v)}
                className="flex w-full items-center justify-between text-left text-xs font-semibold uppercase tracking-wide text-neutral-700"
              >
                Why these essentials
                <span className="text-neutral-400" aria-hidden>
                  {rationaleOpen ? "▾" : "▸"}
                </span>
              </button>
              {rationaleOpen ? (
                <ul className="mt-3 space-y-2 border-t border-neutral-200/60 pt-3 text-sm text-neutral-800">
                  {quality.core_rationale.map((r, i) => (
                    <li key={i}>
                      <span className="font-medium text-neutral-900">
                        {r.name}
                      </span>
                      : {r.why}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Servings */}
      {ingTotal > 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-neutral-200/90 bg-white px-6 py-5 shadow-sm sm:flex-row sm:justify-between">
          <span className="text-sm font-medium text-neutral-600">
            Servings
          </span>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1 rounded-xl border border-neutral-200 bg-neutral-50 p-1">
              <button
                type="button"
                aria-label="Decrease servings"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-xl font-light text-neutral-700 transition hover:bg-white hover:shadow-sm"
                onClick={() => bump(-1)}
              >
                −
              </button>
              <span className="min-w-[2.5rem] text-center text-lg font-semibold tabular-nums text-neutral-900">
                {targetServings}
              </span>
              <button
                type="button"
                aria-label="Increase servings"
                className="flex h-11 w-11 items-center justify-center rounded-lg text-xl font-light text-neutral-700 transition hover:bg-white hover:shadow-sm"
                onClick={() => bump(1)}
              >
                +
              </button>
            </div>
            <div className="flex rounded-lg border border-neutral-200 p-0.5 text-xs font-medium">
              <button
                type="button"
                onClick={() => setShowScaled(true)}
                className={`rounded-md px-3 py-2 transition ${
                  showScaled
                    ? "bg-white text-neutral-900 shadow-sm"
                    : "text-neutral-500 hover:text-neutral-800"
                }`}
              >
                Scaled
              </button>
              <button
                type="button"
                onClick={() => setShowScaled(false)}
                className={`rounded-md px-3 py-2 transition ${
                  !showScaled
                    ? "bg-white text-neutral-900 shadow-sm"
                    : "text-neutral-500 hover:text-neutral-800"
                }`}
              >
                Original
              </button>
            </div>
          </div>
        </div>
      )}

      {baseServings !== targetServings && ingTotal > 0 && (
        <p className="text-center text-xs text-neutral-500">
          Scaled from {baseServings} → {targetServings} servings
        </p>
      )}

      {/* Ingredients */}
      {ingTotal === 0 && !showBuilderCta ? (
        <p className="text-center text-sm text-neutral-400">No ingredients listed.</p>
      ) : ingTotal > 0 ? (
        <div className="space-y-6">
          {core.length > 0 && (
            <section className="overflow-hidden rounded-xl border border-neutral-200/90 bg-white shadow-[0_4px_24px_-4px_rgba(0,0,0,0.08)]">
              <div className="border-b border-neutral-100 bg-neutral-50/80 px-5 py-4">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-800">
                  Core ingredients
                </h2>
                <p className="mt-1 text-xs text-neutral-500">
                  What defines this dish — identity, not garnish
                </p>
              </div>
              <div className="px-5 py-1">
                {core.map((item, i) => (
                  <IngredientCardRow
                    key={`c-${i}`}
                    ing={item}
                    scaled={scaledCore[i]!}
                    showScaled={showScaled}
                    coreRationale={rationaleByName.get(
                      normalizeIngredientName(item.name)
                    )}
                  />
                ))}
              </div>
            </section>
          )}
          {optional.length > 0 && (
            <section className="overflow-hidden rounded-xl border border-neutral-200/90 bg-white shadow-[0_4px_24px_-4px_rgba(0,0,0,0.06)]">
              <div className="border-b border-neutral-100 bg-neutral-50/50 px-5 py-4">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700">
                  Optional & customize
                </h2>
                <p className="mt-1 text-xs text-neutral-500">
                  Skip or adjust to taste
                </p>
              </div>
              <div className="px-5 py-1">
                {optional.map((item, i) => (
                  <IngredientCardRow
                    key={`o-${i}`}
                    ing={item}
                    scaled={scaledOptional[i]!}
                    showScaled={showScaled}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      ) : null}

      {meaningfulSubstitutions.length > 0 && (
        <section className="rounded-xl border border-orange-100 bg-orange-50/50 px-5 py-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-orange-900">
            Substitutions
          </h2>
          <p className="mt-1 text-xs text-orange-800/70">
            Role-preserving swaps — same job in the dish
          </p>
          <ul className="mt-3 space-y-4">
            {meaningfulSubstitutions.map((sub, i) => {
              const o = typeof sub === "object" && sub ? sub : null;
              const main =
                typeof sub === "string"
                  ? sub
                  : String(
                      o?.ingredient ?? o?.original ?? ""
                    ).trim();
              const alts =
                o && Array.isArray(o.options) && o.options.length
                  ? o.options
                  : o && Array.isArray(o.alternatives)
                    ? o.alternatives
                    : [];
              const note = o?.note?.trim();
              if (!main) return null;
              return (
                <li key={i} className="space-y-1 text-[15px]">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-semibold text-orange-950">{main}</span>
                    {alts.length > 0 && (
                      <>
                        <span className="text-orange-800/70">→</span>
                        <span className="text-orange-900/95">
                          {alts.join(" · ")}
                        </span>
                      </>
                    )}
                  </div>
                  {note ? (
                    <p className="text-xs text-orange-800/80">{note}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {steps.length > 0 && (
        <button
          type="button"
          onClick={scrollToCooking}
          className="w-full rounded-xl bg-emerald-600 py-4 text-base font-semibold text-white shadow-md shadow-emerald-900/10 transition hover:bg-emerald-700 active:scale-[0.995]"
        >
          Start cooking
        </button>
      )}

      {/* Steps */}
      <section id="recipe-steps" className="scroll-mt-24 space-y-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-800">
            Steps
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            One cookable flow — ordered, family-aware, no pasted fragments
          </p>
        </div>
        {steps.length === 0 ? (
          <p className="text-sm text-neutral-400">No steps yet.</p>
        ) : (
          <ol className="space-y-4">
            {steps.map((step, i) => (
              <li
                key={i}
                className="rounded-xl border border-neutral-200/90 bg-white p-5 shadow-sm sm:p-6"
              >
                <div className="flex gap-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-sm font-bold text-white">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <h3 className="text-base font-semibold text-neutral-900">
                      {step.title}
                    </h3>
                    <p className="text-xs text-neutral-500">
                      {[
                        step.time &&
                        step.time !== "—" &&
                        step.time !== "As needed"
                          ? `⏱ ${step.time}`
                          : null,
                        step.tools && step.tools.length > 0
                          ? `🛠 ${step.tools.join(", ")}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || null}
                    </p>
                    {step.ingredients_used && step.ingredients_used.length > 0 ? (
                      <p className="text-xs text-neutral-500">
                        Uses: {step.ingredients_used.join(", ")}
                      </p>
                    ) : null}
                    {step.instructions_bullets && step.instructions_bullets.length > 1 ? (
                      <ol className="max-w-prose list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-neutral-800">
                        {step.instructions_bullets.map((line, j) => (
                          <li key={j}>{line}</li>
                        ))}
                      </ol>
                    ) : (
                      <p className="max-w-prose text-[15px] leading-relaxed text-neutral-800">
                        {step.instructions}
                      </p>
                    )}
                    {step.checkpoints && step.checkpoints.length > 0 ? (
                      <ul className="space-y-0.5 text-xs text-emerald-900/80">
                        {step.checkpoints.map((c, j) => (
                          <li key={j} className="border-l-2 border-emerald-200 pl-2">
                            ✓ {c}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {step.warnings && step.warnings.length > 0 ? (
                      <ul className="space-y-0.5 text-xs leading-snug text-amber-900/75">
                        {step.warnings.map((w, j) => (
                          <li key={j} className="border-l-2 border-amber-200/90 pl-2">
                            {w}
                          </li>
                        ))}
                      </ul>
                    ) : step.goal &&
                      step.goal.length > 5 &&
                      !step.goal.startsWith("Complete") ? (
                      <p className="text-xs text-amber-900/70">{step.goal}</p>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {tips.length > 0 && (
        <section className="rounded-xl border border-neutral-200/90 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-800">
            Tips
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            Quick extras from your sources — execution, flavor, style
          </p>
          <ul className="mt-3 space-y-2.5 text-[15px] leading-relaxed text-neutral-700">
            {tips.map((tip, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-emerald-600" aria-hidden>
                  ·
                </span>
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Source history */}
      {versions.length > 0 && (
        <section className="rounded-xl border border-neutral-200/90 bg-white shadow-sm">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="flex w-full items-center justify-between px-5 py-4 text-left"
            aria-expanded={historyOpen}
          >
            <span className="text-sm font-semibold text-neutral-900">
              History — {nSources} source{nSources === 1 ? "" : "s"}
            </span>
            <span
              className={`text-neutral-400 transition-transform duration-200 ease-out ${
                historyOpen ? "rotate-180" : ""
              }`}
            >
              ▼
            </span>
          </button>
          <div
            className={`grid transition-[grid-template-rows] duration-200 ease-out ${
              historyOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
            }`}
          >
            <div className="min-h-0 overflow-hidden">
              <ul className="space-y-4 border-t border-neutral-100 px-5 py-4 text-sm text-neutral-600">
                {versions.slice(0, 10).map((v, i) => (
                  <li key={i} className="leading-relaxed">
                    <span className="font-medium text-neutral-800">
                      {v.at
                        ? new Date(v.at).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })
                        : "Update"}
                    </span>
                    {v.source_count_after ? (
                      <span className="text-neutral-400">
                        {" "}
                        · {v.source_count_after} sources
                      </span>
                    ) : null}
                    <p className="mt-1 text-neutral-600">{v.summary}</p>
                    {v.key_improvements?.length ? (
                      <ul className="mt-2 list-inside list-disc text-xs text-neutral-500">
                        {v.key_improvements.slice(0, 3).map((x, j) => (
                          <li key={j}>{x}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {/* Sources links */}
      {sourceUrls.length > 0 && (
        <section className="rounded-xl border border-neutral-200/90 bg-neutral-50/50 shadow-sm">
          <button
            type="button"
            onClick={() => setSourcesOpen((v) => !v)}
            className="flex w-full items-center justify-between px-5 py-4 text-left"
            aria-expanded={sourcesOpen}
          >
            <span className="text-sm font-semibold text-neutral-800">
              Source links ({sourceUrls.length})
            </span>
            <span
              className={`text-neutral-400 transition-transform duration-200 ${
                sourcesOpen ? "rotate-180" : ""
              }`}
            >
              ▼
            </span>
          </button>
          <div
            className={`grid transition-[grid-template-rows] duration-200 ease-out ${
              sourcesOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
            }`}
          >
            <div className="min-h-0 overflow-hidden">
              <ul className="space-y-2 border-t border-neutral-100 px-5 py-4">
                {sourceUrls.map((url, i) => (
                  <li key={i} className="break-all text-sm">
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-700 underline decoration-blue-200 underline-offset-2 hover:text-blue-900"
                    >
                      {url}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      <p className="pb-4 text-center text-xs text-neutral-400">
        Recipe improves as you add sources via the extension.
      </p>

      {(onEdit || onSave || onDuplicate) && (
        <div className="flex flex-wrap gap-2 border-t border-neutral-100 pt-6">
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Edit
            </button>
          )}
          {onSave && (
            <button
              type="button"
              onClick={onSave}
              className="rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800"
            >
              Save
            </button>
          )}
          {onDuplicate && (
            <button
              type="button"
              onClick={onDuplicate}
              className="rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Duplicate
            </button>
          )}
        </div>
      )}
    </article>
  );
}
