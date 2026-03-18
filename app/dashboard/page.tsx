import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";
import { RecipeCard } from "@/components/RecipeCard";

export const dynamic = "force-dynamic";

type DashboardRecipe = {
  id: string;
  title: string;
  description: string;
  source_platforms: string[];
  source_urls: string[];
  updated_at: string | null;
  created_at: string | null;
};

async function getRecipes(): Promise<DashboardRecipe[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("recipes")
    .select(
      "id, title, description, source_platforms, source_urls, updated_at, created_at"
    )
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return [];
  return (data ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description ?? "",
    source_platforms: (r.source_platforms as string[]) ?? [],
    source_urls: (r.source_urls as string[]) ?? [],
    updated_at: r.updated_at ?? null,
    created_at: r.created_at ?? null,
  }));
}

function formatUpdated(iso: string | null, created: string | null) {
  const d = iso || created;
  if (!d) return "";
  try {
    return new Date(d).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
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
        <h2 className="text-xl font-semibold text-neutral-900">
          Your saved recipes
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Browse → Save pages with the extension → Your recipe improves over time.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {recipes.length === 0 ? (
            <div className="col-span-full rounded-2xl border border-dashed border-neutral-200 bg-white p-12 text-center text-neutral-500">
              No recipes yet.{" "}
              <Link href="/create" className="text-neutral-900 underline">
                Create one
              </Link>{" "}
              or use the Chrome extension on a recipe page.
            </div>
          ) : (
            recipes.map((recipe) => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                sourceCount={Math.max(
                  recipe.source_urls?.length ?? 0,
                  recipe.source_platforms?.length ?? 0
                )}
                updatedLabel={formatUpdated(
                  recipe.updated_at,
                  recipe.created_at
                )}
              />
            ))
          )}
        </div>
      </main>
    </div>
  );
}
