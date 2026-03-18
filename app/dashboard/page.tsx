import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";
import { RecipeCard } from "@/components/RecipeCard";

export const dynamic = "force-dynamic";

type DashboardRecipe = {
  id: string;
  title: string;
  description: string;
  source_platforms: string[];
};

async function getRecipes(): Promise<DashboardRecipe[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("recipes")
    .select("id, title, description, source_platforms")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return [];
  return (data ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    source_platforms: (r.source_platforms as string[]) ?? [],
  }));
}

export default async function DashboardPage() {
  const recipes = await getRecipes();
  return (
    <div className="min-h-screen bg-[#fafafa]">
      <header className="border-b border-neutral-100 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link href="/" className="text-lg font-semibold text-neutral-900">
            Recipe Cloud
          </Link>
          <Link
            href="/create"
            className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
          >
            New Recipe
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <h2 className="text-xl font-semibold text-neutral-900">Your recipes</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Search by title or ingredient (coming soon)
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {recipes.length === 0 ? (
            <div className="col-span-full rounded-2xl border border-dashed border-neutral-200 bg-white p-12 text-center text-neutral-500">
              No recipes yet.{" "}
              <Link href="/create" className="text-neutral-900 underline">
                Create one
              </Link>
            </div>
          ) : (
            recipes.map((recipe) => (
              <RecipeCard key={recipe.id} recipe={recipe} />
            ))
          )}
        </div>
      </main>
    </div>
  );
}
