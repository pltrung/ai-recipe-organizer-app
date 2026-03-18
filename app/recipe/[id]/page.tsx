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
    source_platforms: Array.isArray(data.source_platforms) ? data.source_platforms : [],
  };
}

export default async function RecipePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const recipe = await getRecipe(id);
  if (!recipe) notFound();

  const sourceCount = recipe.source_urls?.length ?? 0;

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
        <RecipeView recipe={recipe} sourceCount={sourceCount} />
      </main>
    </div>
  );
}
