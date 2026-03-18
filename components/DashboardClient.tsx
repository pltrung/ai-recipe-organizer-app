"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export type DashboardRecipeRow = {
  id: string;
  title: string;
  description: string;
  sourceCount: number;
  updatedLabel: string;
};

export function DashboardClient({ recipes }: { recipes: DashboardRecipeRow[] }) {
  const [list, setList] = useState(recipes);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const router = useRouter();

  // Sync list when server sends fresh data (e.g. after navigating back to dashboard)
  useEffect(() => {
    setList(recipes);
  }, [recipes]);

  async function confirmDelete() {
    if (!confirmId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/recipes/${confirmId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && (data.ok === true || !data.error)) {
        setList((prev) => prev.filter((r) => r.id !== confirmId));
        setConfirmId(null);
        router.refresh();
      }
    } finally {
      setDeleting(false);
    }
  }

  if (list.length === 0) {
    return (
      <div className="col-span-full rounded-2xl border border-dashed border-neutral-200 bg-white p-12 text-center text-neutral-500">
        No recipes yet.{" "}
        <Link href="/create" className="text-neutral-900 underline">
          Create one
        </Link>{" "}
        or use the Chrome extension on a recipe page.
      </div>
    );
  }

  return (
    <>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((recipe) => (
          <div
            key={recipe.id}
            className="flex flex-col overflow-hidden rounded-2xl border border-neutral-100 bg-white shadow-sm transition-shadow hover:shadow-md"
          >
            <Link
              href={`/recipe/${recipe.id}`}
              className="block flex-1 p-5 hover:bg-neutral-50/80"
            >
              <h3 className="font-semibold text-neutral-900">{recipe.title}</h3>
              {recipe.description && (
                <p className="mt-1 line-clamp-2 text-sm text-neutral-500">
                  {recipe.description}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-400">
                <span>
                  {recipe.sourceCount} source{recipe.sourceCount !== 1 ? "s" : ""}
                </span>
                {recipe.updatedLabel && (
                  <>
                    <span aria-hidden>·</span>
                    <span>Updated {recipe.updatedLabel}</span>
                  </>
                )}
              </div>
            </Link>
            <div className="border-t border-neutral-100 bg-neutral-50/50 px-3 py-2">
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setConfirmId(recipe.id);
                }}
                className="text-sm font-medium text-red-600 hover:text-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {confirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
            role="dialog"
            aria-labelledby="delete-title"
          >
            <h2
              id="delete-title"
              className="text-lg font-semibold text-neutral-900"
            >
              Delete this recipe?
            </h2>
            <p className="mt-2 text-sm text-neutral-500">
              This cannot be undone. All saved sources and merged content will be
              removed.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmId(null)}
                disabled={deleting}
                className="rounded-xl border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleting}
                className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
