"use client";

import type { ExtractedRecipe } from "@/lib/types";

type MergePreviewProps = {
  recipes: ExtractedRecipe[];
  mergedTitle?: string;
};

export function MergePreview({ recipes, mergedTitle }: MergePreviewProps) {
  if (recipes.length === 0) return null;
  return (
    <div className="rounded-2xl border border-neutral-100 bg-neutral-50/50 p-4">
      <p className="text-sm font-medium text-neutral-700">
        {mergedTitle
          ? `Combined into: ${mergedTitle}`
          : `Combining ${recipes.length} recipe${recipes.length !== 1 ? "s" : ""}...`}
      </p>
      {!mergedTitle && (
        <ul className="mt-2 space-y-1 text-sm text-neutral-500">
          {recipes.map((r, i) => (
            <li key={i}>{r.title}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
