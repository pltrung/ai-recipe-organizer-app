import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import { RecipeView } from "@/components/RecipeView";
import { RecipeUpdatedModal } from "@/components/RecipeUpdatedModal";
import { recipeFromDbRow } from "@/lib/parseRecipeFromDb";
import type { Recipe } from "@/lib/types";

export const dynamic = "force-dynamic";

async function getRecipe(id: string): Promise<Recipe | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("recipes")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !data) return null;
  return recipeFromDbRow(data as Record<string, unknown>);
}

export default async function RecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from_reel?: string; updated?: string }>;
}) {
  const { id } = await params;
  const { from_reel, updated } = await searchParams;
  const recipe = await getRecipe(id);
  if (!recipe) notFound();

  const sourceCount = Math.max(
    recipe.source_platforms?.length ?? 0,
    recipe.source_urls?.length ?? 0
  );

  return (
    <div className="min-h-screen bg-[#fafafa]">
      <header className="border-b border-neutral-100 bg-white">
        <div className="mx-auto flex max-w-[720px] items-center justify-between px-4 py-4">
          <Link href="/dashboard" className="text-sm font-medium text-neutral-600 hover:text-neutral-900">
            ← Dashboard
          </Link>
          <Link href="/create" className="text-sm font-medium text-neutral-600 hover:text-neutral-900">
            New recipe
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-[720px] px-4 py-8 sm:py-12">
        <RecipeUpdatedModal
          lastDiff={recipe.last_diff}
          openWhenPresent={updated != null && updated !== ""}
        />
        {from_reel === "1" && (
          <p className="mb-6 rounded-xl bg-amber-50 px-4 py-2 text-sm text-amber-800">
            We created this recipe from a short video. Edit ingredients and
            steps below if needed.
          </p>
        )}
        <RecipeView
          recipe={recipe}
          sourceCount={sourceCount}
          needsUserInput={recipe.needs_user_input}
          needsReview={recipe.needs_review}
          lastDiff={recipe.last_diff}
        />
      </main>
    </div>
  );
}
