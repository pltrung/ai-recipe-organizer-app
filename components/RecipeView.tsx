"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Recipe, ScaledIngredient, StructuredIngredient } from "@/lib/types";
import {
  formatIngredientOriginal,
  formatQuantity,
  formatScaledLine,
  scaleIngredients,
} from "@/lib/ingredientScale";

const EMPTY_ING: StructuredIngredient[] = [];

type RecipeViewProps = {
  recipe: Recipe;
  sourceCount?: number;
  needsUserInput?: boolean;
  onEdit?: () => void;
  onSave?: () => void;
  onDuplicate?: () => void;
};

function IngredientLine({
  ing,
  scaled,
  baseServings,
  targetServings,
  showScaled,
  bulletClass,
  textClass,
}: {
  ing: StructuredIngredient;
  scaled: ScaledIngredient;
  baseServings: number;
  targetServings: number;
  showScaled: boolean;
  bulletClass: string;
  textClass: string;
}) {
  const original = formatIngredientOriginal(ing);
  const canScale =
    scaled.scaledQuantity != null && Boolean(ing.unit) && ing.quantity != null;
  const useScaled = showScaled && canScale;
  const main = useScaled ? formatScaledLine(scaled) : original;
  const sq = scaled.scaledQuantity;
  const showArrow =
    useScaled &&
    targetServings !== baseServings &&
    ing.quantity != null &&
    ing.unit &&
    sq != null;

  return (
    <li className={`flex gap-2 ${textClass}`}>
      <span className={bulletClass}>·</span>
      <span className="min-w-0">
        <span>{main}</span>
        {showArrow && (
          <span className="ml-2 text-xs text-neutral-400">
            ({formatQuantity(ing.quantity!)} {ing.unit} → {formatQuantity(sq)} {ing.unit})
          </span>
        )}
      </span>
    </li>
  );
}

export function RecipeView({
  recipe,
  sourceCount = 0,
  needsUserInput = false,
  onEdit,
  onSave,
  onDuplicate,
}: RecipeViewProps) {
  const core = recipe.ingredients?.core ?? EMPTY_ING;
  const optional = recipe.ingredients?.optional ?? EMPTY_ING;
  const steps = Array.isArray(recipe.steps) ? recipe.steps : [];
  const tips = Array.isArray(recipe.tips) ? recipe.tips : [];
  const substitutions = Array.isArray(recipe.substitutions)
    ? recipe.substitutions
    : [];
  const sourceUrls = Array.isArray(recipe.source_urls) ? recipe.source_urls : [];
  const ingTotal = core.length + optional.length;
  const isEmpty = ingTotal === 0 && steps.length === 0;
  const showBuilderCta = needsUserInput || isEmpty;

  const baseServings = Math.max(1, recipe.servings_base ?? 1);
  const [targetServings, setTargetServings] = useState(baseServings);
  const [showScaled, setShowScaled] = useState(true);

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

  const bump = (d: number) => {
    setTargetServings((n) => Math.min(99, Math.max(1, n + d)));
  };

  return (
    <article className="mx-auto max-w-2xl">
      {showBuilderCta && (
        <div className="mb-8 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-amber-950">
          <p className="font-medium">We couldn’t extract everything yet.</p>
          <p className="mt-1 text-sm text-amber-900/90">
            Add more sources to improve your recipe — use the Recipe Cloud
            extension on recipe pages while this recipe is your{" "}
            <strong>active recipe</strong>, or paste links on Create.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/create"
              className="inline-flex rounded-xl bg-amber-900 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800"
            >
              + Add another link
            </Link>
            <Link
              href="/dashboard"
              className="inline-flex rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-950 hover:bg-amber-100/50"
            >
              Go to dashboard
            </Link>
          </div>
        </div>
      )}

      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
          {recipe.title}
        </h1>
        {recipe.description && (
          <p className="mt-2 text-neutral-600">{recipe.description}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2 text-sm text-neutral-500">
          {recipe.estimated_time && recipe.estimated_time !== "—" && (
            <span>{recipe.estimated_time}</span>
          )}
          {recipe.servings && <span> · {recipe.servings}</span>}
        </div>
      </header>

      <div className="mb-8 rounded-xl border border-sky-100 bg-sky-50/80 px-4 py-3 text-sm text-sky-950">
        <p className="font-medium text-sky-900">Keep building this recipe</p>
        <p className="mt-1 text-sky-800/90">
          Recipe improves as you add more sources — use the Recipe Cloud
          extension on any blog or video page and send it to this recipe.
        </p>
      </div>

      {sourceUrls.length > 0 && (
        <section className="mb-10 rounded-2xl border border-neutral-200 bg-white px-5 py-4 shadow-sm">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-neutral-600">
            Sources
          </h2>
          <p className="mb-3 text-sm text-neutral-500">
            <strong className="text-neutral-800">{sourceCount || sourceUrls.length}</strong>{" "}
            saved source
            {(sourceCount || sourceUrls.length) !== 1 ? "s" : ""}
          </p>
          <ul className="space-y-2">
            {sourceUrls.map((url, i) => (
              <li key={i} className="break-all text-sm">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-neutral-700 underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900"
                >
                  {url}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-10">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Ingredients
          </h2>
          {ingTotal > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 rounded-xl border border-neutral-200 bg-white px-2 py-1.5 shadow-sm">
                <span className="pl-1 text-xs font-medium text-neutral-500">
                  Adjust servings
                </span>
                <button
                  type="button"
                  aria-label="Fewer servings"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200 text-lg font-medium text-neutral-700 hover:bg-neutral-50"
                  onClick={() => bump(-1)}
                >
                  −
                </button>
                <span className="min-w-[2rem] text-center text-sm font-semibold tabular-nums text-neutral-900">
                  {targetServings}
                </span>
                <button
                  type="button"
                  aria-label="More servings"
                  className="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200 text-lg font-medium text-neutral-700 hover:bg-neutral-50"
                  onClick={() => bump(1)}
                >
                  +
                </button>
              </div>
              <div className="flex rounded-xl border border-neutral-200 bg-neutral-50 p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setShowScaled(true)}
                  className={`rounded-lg px-3 py-1.5 transition-colors ${
                    showScaled
                      ? "bg-white text-neutral-900 shadow-sm"
                      : "text-neutral-500 hover:text-neutral-800"
                  }`}
                >
                  Show scaled
                </button>
                <button
                  type="button"
                  onClick={() => setShowScaled(false)}
                  className={`rounded-lg px-3 py-1.5 transition-colors ${
                    !showScaled
                      ? "bg-white text-neutral-900 shadow-sm"
                      : "text-neutral-500 hover:text-neutral-800"
                  }`}
                >
                  Show original
                </button>
              </div>
            </div>
          )}
        </div>
        {baseServings !== targetServings && ingTotal > 0 && (
          <p className="mb-3 text-xs text-neutral-500">
            Scaled from <strong>{baseServings}</strong> serving
            {baseServings !== 1 ? "s" : ""} (recipe base) →{" "}
            <strong>{targetServings}</strong>.
          </p>
        )}
        {ingTotal === 0 ? (
          <p className="text-sm text-neutral-400">No ingredients yet.</p>
        ) : (
          <div className="space-y-6">
            {core.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                  Core
                </h3>
                <p className="mb-2 text-xs text-neutral-500">
                  Appeared across multiple sources — main building blocks.
                </p>
                <ul className="space-y-2">
                  {core.map((item, i) => (
                    <IngredientLine
                      key={`c-${i}`}
                      ing={item}
                      scaled={scaledCore[i]!}
                      baseServings={baseServings}
                      targetServings={targetServings}
                      showScaled={showScaled}
                      bulletClass="text-emerald-600"
                      textClass="text-neutral-800"
                    />
                  ))}
                </ul>
              </div>
            )}
            {optional.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-600">
                  Optional
                </h3>
                <p className="mb-2 text-xs text-neutral-500">
                  From a single source — variations or add-ons.
                </p>
                <ul className="space-y-2">
                  {optional.map((item, i) => (
                    <IngredientLine
                      key={`o-${i}`}
                      ing={item}
                      scaled={scaledOptional[i]!}
                      baseServings={baseServings}
                      targetServings={targetServings}
                      showScaled={showScaled}
                      bulletClass="text-neutral-400"
                      textClass="text-neutral-700"
                    />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {substitutions.length > 0 && (
        <section className="mb-10 rounded-2xl border border-amber-100 bg-amber-50/60 px-5 py-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-amber-900">
            Substitutions
          </h2>
          <ul className="space-y-2 text-sm text-amber-950">
            {substitutions.map((line, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-amber-600">↔</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-neutral-500">
          Steps
        </h2>
        {steps.length === 0 ? (
          <p className="text-sm text-neutral-400">No steps yet.</p>
        ) : (
          <ol className="space-y-4">
            {steps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-sm font-semibold text-white">
                  {i + 1}
                </span>
                <span className="pt-0.5 text-neutral-800 leading-relaxed">
                  {step}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {tips.length > 0 && (
        <section className="mb-10 rounded-2xl border border-violet-100 bg-violet-50/60 px-5 py-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-violet-900">
            Tips & enhancements
          </h2>
          <ul className="space-y-2 text-sm text-violet-950">
            {tips.map((tip, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-violet-500">✦</span>
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(onEdit || onSave || onDuplicate) && (
        <div className="mt-8 flex gap-2">
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Edit
            </button>
          )}
          {onSave && (
            <button
              type="button"
              onClick={onSave}
              className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
            >
              Save
            </button>
          )}
          {onDuplicate && (
            <button
              type="button"
              onClick={onDuplicate}
              className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Duplicate
            </button>
          )}
        </div>
      )}
    </article>
  );
}
