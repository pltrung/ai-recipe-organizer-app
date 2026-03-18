"use client";

import { useEffect, useState } from "react";
import type { RecipeLastDiff } from "@/lib/types";

type Props = {
  lastDiff: RecipeLastDiff | null | undefined;
  /** Open when user lands from extension (?updated=) */
  openWhenPresent: boolean;
};

export function RecipeUpdatedModal({ lastDiff, openWhenPresent }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (openWhenPresent && lastDiff?.at) {
      setOpen(true);
    }
  }, [openWhenPresent, lastDiff?.at]);

  const hasContent =
    lastDiff &&
    (lastDiff.summary ||
      (lastDiff.ingredient_changes?.length ?? 0) > 0 ||
      (lastDiff.step_changes?.length ?? 0) > 0 ||
      (lastDiff.new_insights?.length ?? 0) > 0);
  if (!hasContent) return null;

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center"
          role="dialog"
          aria-labelledby="recipe-updated-title"
        >
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <h2
              id="recipe-updated-title"
              className="text-lg font-semibold text-neutral-900"
            >
              Recipe updated
            </h2>
            <p className="mt-2 text-sm text-neutral-600">{lastDiff.summary}</p>
            <p className="mt-1 text-xs text-neutral-400">
              {lastDiff.source_count_after} source
              {lastDiff.source_count_after === 1 ? "" : "s"} ·{" "}
              {lastDiff.at
                ? new Date(lastDiff.at).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : ""}
            </p>

            {lastDiff.new_insights.length > 0 && (
              <section className="mt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
                  New insights
                </h3>
                <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-neutral-700">
                  {lastDiff.new_insights.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </section>
            )}

            {lastDiff.ingredient_changes.length > 0 && (
              <section className="mt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                  Ingredient changes
                </h3>
                <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-neutral-700">
                  {lastDiff.ingredient_changes.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </section>
            )}

            {lastDiff.step_changes.length > 0 && (
              <section className="mt-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-blue-900">
                  Step improvements
                </h3>
                <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-neutral-700">
                  {lastDiff.step_changes.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </section>
            )}

            <button
              type="button"
              className="mt-6 w-full rounded-xl bg-neutral-900 py-3 text-sm font-medium text-white hover:bg-neutral-800"
              onClick={() => setOpen(false)}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
