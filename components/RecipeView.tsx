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

function IngredientCardRow({
  ing,
  scaled,
  showScaled,
}: {
  ing: StructuredIngredient;
  scaled: ScaledIngredient;
  showScaled: boolean;
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

  return (
    <div className="border-b border-neutral-100 py-3.5 text-[15px] leading-snug last:border-0">
      <span className="font-medium text-neutral-900">{line}</span>
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

  const core = useMemo(
    () => dedupeIngredientList(coreRaw),
    [coreRaw]
  );
  const optional = useMemo(
    () => dedupeIngredientList(optionalRaw),
    [optionalRaw]
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
          Recently improved
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
      </header>

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
                  Essential for this dish
                </p>
              </div>
              <div className="px-5 py-1">
                {core.map((item, i) => (
                  <IngredientCardRow
                    key={`c-${i}`}
                    ing={item}
                    scaled={scaledCore[i]!}
                    showScaled={showScaled}
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

      {substitutions.length > 0 && (
        <section className="rounded-xl border border-orange-100 bg-orange-50/50 px-5 py-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-orange-900">
            Substitutions
          </h2>
          <ul className="mt-4 space-y-4">
            {substitutions.map((sub, i) => {
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
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-800">
          Steps
        </h2>
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
                    <div className="flex flex-wrap gap-3 text-xs text-neutral-500">
                      {step.time && step.time !== "—" && step.time !== "As needed" ? (
                        <span>⏱ {step.time}</span>
                      ) : null}
                      {step.tools && step.tools.length > 0 ? (
                        <span>🛠 {step.tools.join(", ")}</span>
                      ) : null}
                    </div>
                    <p className="text-[15px] leading-relaxed text-neutral-700">
                      {step.instructions}
                    </p>
                    {step.warnings && step.warnings.length > 0 ? (
                      <ul className="space-y-1 rounded-lg border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-sm text-amber-950">
                        {step.warnings.map((w, j) => (
                          <li key={j}>⚠ {w}</li>
                        ))}
                      </ul>
                    ) : step.goal &&
                      step.goal.length > 5 &&
                      !step.goal.startsWith("Complete") ? (
                      <p className="text-sm text-amber-900/90">{step.goal}</p>
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
          <ul className="mt-4 space-y-2.5 text-[15px] leading-relaxed text-neutral-700">
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
              Updated from {nSources} sources
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
