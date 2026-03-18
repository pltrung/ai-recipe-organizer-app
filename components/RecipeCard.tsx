"use client";

import Link from "next/link";
import type { Recipe } from "@/lib/types";

type RecipeCardProps = {
  recipe: Pick<
    Recipe,
    "id" | "title" | "description" | "source_platforms" | "source_urls"
  >;
  sourceCount?: number;
  updatedLabel?: string;
};

export function RecipeCard({
  recipe,
  sourceCount: sourceCountProp,
  updatedLabel,
}: RecipeCardProps) {
  const urls = Array.isArray(recipe.source_urls) ? recipe.source_urls : [];
  const platforms = Array.isArray(recipe.source_platforms)
    ? recipe.source_platforms
    : [];
  const n =
    sourceCountProp ??
    Math.max(urls.length, platforms.length, platforms.length ? 1 : 0);

  return (
    <Link
      href={recipe.id ? `/recipe/${recipe.id}` : "#"}
      className="block rounded-2xl border border-neutral-100 bg-white p-5 shadow-sm transition-shadow hover:shadow-md"
    >
      <h3 className="font-semibold text-neutral-900">{recipe.title}</h3>
      {recipe.description && (
        <p className="mt-1 line-clamp-2 text-sm text-neutral-500">
          {recipe.description}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-400">
        <span>
          {n} source{n !== 1 ? "s" : ""}
        </span>
        {updatedLabel && (
          <>
            <span aria-hidden>·</span>
            <span>Updated {updatedLabel}</span>
          </>
        )}
      </div>
    </Link>
  );
}
