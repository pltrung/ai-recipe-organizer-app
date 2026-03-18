"use client";

import Link from "next/link";
import type { Recipe } from "@/lib/types";

type RecipeViewProps = {
  recipe: Recipe;
  sourceCount?: number;
  needsUserInput?: boolean;
  onEdit?: () => void;
  onSave?: () => void;
  onDuplicate?: () => void;
};

export function RecipeView({
  recipe,
  sourceCount = 0,
  needsUserInput = false,
  onEdit,
  onSave,
  onDuplicate,
}: RecipeViewProps) {
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const steps = Array.isArray(recipe.steps) ? recipe.steps : [];
  const sourceUrls = Array.isArray(recipe.source_urls) ? recipe.source_urls : [];
  const isEmpty = ingredients.length === 0 && steps.length === 0;
  const showBuilderCta = needsUserInput || isEmpty;

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
          {recipe.estimated_time && <span>{recipe.estimated_time}</span>}
          {recipe.servings && <span> · {recipe.servings}</span>}
        </div>
      </header>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-neutral-500">
          Ingredients
        </h2>
        {ingredients.length === 0 ? (
          <p className="text-sm text-neutral-400">No ingredients yet.</p>
        ) : (
          <ul className="space-y-2">
            {ingredients.map((item, i) => (
              <li key={i} className="flex gap-2 text-neutral-800">
                <span className="text-neutral-400">·</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

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
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-sm font-medium text-neutral-600">
                  {i + 1}
                </span>
                <span className="text-neutral-800">{step}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {sourceUrls.length > 0 && (
        <footer className="border-t border-neutral-100 pt-6">
          <p className="mb-2 text-sm text-neutral-500">
            Crafted from {sourceCount || sourceUrls.length} source
            {(sourceCount || sourceUrls.length) !== 1 ? "s" : ""}
          </p>
          <ul className="flex flex-wrap gap-2">
            {sourceUrls.map((url, i) => (
              <li key={i}>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-neutral-600 underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900"
                >
                  Source {i + 1}
                </a>
              </li>
            ))}
          </ul>
        </footer>
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
