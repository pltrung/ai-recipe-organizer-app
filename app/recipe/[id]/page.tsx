import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import { RecipeView } from "@/components/RecipeView";
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
  return {
    id: data.id,
    title: data.title,
    description: data.description ?? "",
    ingredients: Array.isArray(data.ingredients) ? data.ingredients : [],
    steps: Array.isArray(data.steps) ? data.steps : [],
    estimated_time: data.estimated_time ?? "",
    servings: data.servings ?? "",
    source_urls: Array.isArray(data.source_urls) ? data.source_urls : [],
    source_platforms: Array.isArray(data.source_platforms)
      ? data.source_platforms
      : [],
    needs_user_input: Boolean(data.needs_user_input),
  };
}

export default async function RecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from_reel?: string }>;
}) {
  const { id } = await params;
  const { from_reel } = await searchParams;
  const recipe = await getRecipe(id);
  if (!recipe) notFound();

  const sourceCount = Math.max(
    recipe.source_platforms?.length ?? 0,
    recipe.source_urls?.length ?? 0
  );

  return (
    <div className="min-h-screen bg-[#fafafa]">
      <header className="border-b border-neutral-100 bg-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-4">
          <Link href="/dashboard" className="text-sm font-medium text-neutral-600 hover:text-neutral-900">
            ← Dashboard
          </Link>
          <Link href="/create" className="text-sm font-medium text-neutral-600 hover:text-neutral-900">
            New recipe
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-10">
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
        />
      </main>
    </div>
  );
}
