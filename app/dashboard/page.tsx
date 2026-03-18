import Link from "next/link";
import { createClient } from "@/lib/supabaseClient";
import {
  DashboardClient,
  type DashboardRecipeRow,
} from "@/components/DashboardClient";

export const dynamic = "force-dynamic";

async function getRecipes(): Promise<DashboardRecipeRow[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("recipes")
    .select(
      "id, title, description, source_platforms, source_urls, updated_at, created_at"
    )
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return [];
  return (data ?? []).map((r) => {
    const urls = (r.source_urls as string[]) ?? [];
    const plats = (r.source_platforms as string[]) ?? [];
    const n = Math.max(urls.length, plats.length);
    const d = r.updated_at ?? r.created_at;
    let updatedLabel = "";
    if (d) {
      try {
        updatedLabel = new Date(d).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
      } catch {
        updatedLabel = "";
      }
    }
    return {
      id: r.id,
      title: r.title,
      description: r.description ?? "",
      sourceCount: n,
      updatedLabel,
    };
  });
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
          Browse → Pick a recipe in the extension → Add pages → Your recipe
          improves over time.
        </p>
        <DashboardClient recipes={recipes} />
      </main>
    </div>
  );
}
