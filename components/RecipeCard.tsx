"use client";

import Link from "next/link";
import type { Recipe } from "@/lib/types";

type RecipeCardProps = {
  recipe: Pick<Recipe, "id" | "title" | "description" | "source_platforms">;
};

export function RecipeCard({ recipe }: RecipeCardProps) {
  const platforms = Array.isArray(recipe.source_platforms)
    ? recipe.source_platforms
    : [];
  const platformLabel =
    platforms.length > 0 ? platforms.slice(0, 2).join(", ") : "Recipe";

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
      {platformLabel && (
        <p className="mt-2 text-xs text-neutral-400">{platformLabel}</p>
      )}
    </Link>
  );
}
