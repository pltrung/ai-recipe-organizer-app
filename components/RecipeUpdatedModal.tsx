"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { RecipeLastDiff } from "@/lib/types";

type Props = {
  lastDiff: RecipeLastDiff | null | undefined;
  openWhenPresent: boolean;
  /** Open from in-page “Recently improved” (independent of ?updated=) */
  forceOpen?: boolean;
  onForceClose?: () => void;
};

function snapshotBullets(d: RecipeLastDiff): string[] {
  const k = d.key_improvements?.filter(Boolean) ?? [];
  if (k.length) return k.slice(0, 5);
  return [
    ...(d.new_insights ?? []),
    ...(d.ingredient_changes ?? []).map((x) => String(x)),
    ...(d.step_changes ?? []).map((x) => String(x)),
  ].slice(0, 4);
}

function insightLines(d: RecipeLastDiff): string[] {
  const api = d.new_insights?.filter(Boolean) ?? [];
  if (api.length) return api;
  const s = d.structured;
  if (!s) return [];
  const out: string[] = [];
  for (const t of s.new_tips) out.push(t);
  for (const t of s.new_techniques) out.push(`Technique: ${t}`);
  for (const t of s.new_mistakes) out.push(`Note: ${t}`);
  return out.slice(0, 24);
}

function ingredientLines(d: RecipeLastDiff): string[] {
  const api = d.ingredient_changes?.filter(Boolean) ?? [];
  if (api.length) return api;
  const s = d.structured;
  if (!s) return [];
  const out: string[] = [];
  for (const x of s.added_core) out.push(`Added to core: ${x}`);
  for (const x of s.removed_core) out.push(`Removed from core: ${x}`);
  for (const x of s.moved_optional_to_core) out.push(`Now essential: ${x}`);
  for (const x of s.moved_core_to_optional) out.push(`Moved to optional: ${x}`);
  for (const x of s.added_optional) out.push(`New optional: ${x}`);
  for (const x of s.removed_optional) out.push(`Removed optional: ${x}`);
  return out.slice(0, 24);
}

function stepLines(d: RecipeLastDiff): string[] {
  const api = d.step_changes?.filter(Boolean) ?? [];
  if (api.length) return api;
  const s = d.structured;
  if (!s) return [];
  const out: string[] = [];
  if (s.steps_new.length) {
    out.push(`${s.steps_new.length} new step(s)`);
    for (const t of s.steps_new.slice(0, 3)) {
      const short = t.length > 100 ? `${t.slice(0, 97)}…` : t;
      out.push(`· ${short}`);
    }
  }
  if (s.steps_modified.length) {
    out.push(`${s.steps_modified.length} step(s) refined`);
    for (const m of s.steps_modified.slice(0, 2)) {
      const a = m.after.length > 80 ? `${m.after.slice(0, 77)}…` : m.after;
      out.push(`· ${a}`);
    }
  }
  if (s.steps_removed.length) {
    out.push(`${s.steps_removed.length} step(s) removed or merged`);
  }
  return out;
}

export function RecipeUpdatedModal({
  lastDiff,
  openWhenPresent,
  forceOpen = false,
  onForceClose,
}: Props) {
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if ((openWhenPresent || forceOpen) && lastDiff?.at) {
      setOpen(true);
      if (openWhenPresent) setDetailsOpen(false);
    }
  }, [openWhenPresent, forceOpen, lastDiff?.at]);

  const dismiss = () => {
    setOpen(false);
    onForceClose?.();
  };

  const snapshots = lastDiff ? snapshotBullets(lastDiff) : [];
  const insights = lastDiff ? insightLines(lastDiff) : [];
  const ingredients = lastDiff ? ingredientLines(lastDiff) : [];
  const steps = lastDiff ? stepLines(lastDiff) : [];
  const hasDetails =
    insights.length > 0 || ingredients.length > 0 || steps.length > 0;

  const hasContent = useMemo(
    () =>
      Boolean(
        lastDiff &&
          (lastDiff.summary ||
            snapshots.length > 0 ||
            hasDetails)
      ),
    [lastDiff, snapshots.length, hasDetails]
  );

  if (!hasContent || !lastDiff) return null;

  const sourceCount = Math.max(1, lastDiff.source_count_after || 1);

  const handleViewRecipe = () => {
    dismiss();
    if (pathname) router.replace(pathname, { scroll: false });
  };

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px]"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleViewRecipe();
          }}
        >
          <div
            className="max-h-[min(90vh,720px)] w-full max-w-[480px] space-y-4 overflow-y-auto rounded-xl bg-white p-6 shadow-[0_25px_50px_-12px_rgba(0,0,0,0.18)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recipe-improved-title"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <header className="space-y-2">
              <div className="flex items-center gap-2">
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-50 text-lg"
                  aria-hidden
                >
                  ✨
                </span>
                <h2
                  id="recipe-improved-title"
                  className="text-xl font-semibold tracking-tight text-neutral-900"
                >
                  Recipe updated
                </h2>
              </div>
              <p className="pl-[44px] text-[15px] leading-relaxed text-neutral-600">
                {lastDiff.summary ||
                  "Your recipe absorbed the new source — see what shifted below."}
              </p>
              {lastDiff.merge_quality_score != null ? (
                <p className="pl-[44px] text-sm text-neutral-500">
                  Merge quality{" "}
                  <span className="font-semibold text-neutral-800">
                    {lastDiff.merge_quality_score}/100
                  </span>
                  {lastDiff.is_proposal_better ? " · Likely upgrade" : " · Review before applying"}
                  {lastDiff.merge_quality_reason ? (
                    <span className="block mt-1 text-xs text-neutral-400">
                      {lastDiff.merge_quality_reason}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </header>

            {/* Snapshot */}
            {snapshots.length > 0 && (
              <section className="space-y-3 rounded-xl border border-emerald-100/80 bg-gradient-to-b from-emerald-50/60 to-white px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-emerald-800/90">
                  What changed
                </p>
                <ul className="space-y-3">
                  {snapshots.map((line, i) => (
                    <li
                      key={i}
                      className="flex gap-3 text-[15px] leading-snug text-neutral-800"
                    >
                      <span
                        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                        aria-hidden
                      />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Expandable details */}
            {hasDetails && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setDetailsOpen((v) => !v)}
                  className="flex w-full items-center justify-between rounded-xl border border-neutral-200/90 bg-neutral-50/50 px-4 py-3 text-left text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-100/80"
                  aria-expanded={detailsOpen}
                >
                  <span>See details</span>
                  <span
                    className={`text-neutral-400 transition-transform duration-200 ease-out ${
                      detailsOpen ? "rotate-180" : ""
                    }`}
                    aria-hidden
                  >
                    ▼
                  </span>
                </button>
                <div
                  className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                    detailsOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                  }`}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="space-y-4 border-t border-neutral-100 pt-4">
                      {insights.length > 0 && (
                        <section className="space-y-2">
                          <h3 className="text-xs font-semibold uppercase tracking-wide text-blue-700">
                            New insights
                          </h3>
                          <ul className="space-y-2 text-sm leading-relaxed text-neutral-700">
                            {insights.map((x, i) => (
                              <li
                                key={i}
                                className="border-l-2 border-blue-400/70 pl-3"
                              >
                                {x}
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                      {ingredients.length > 0 && (
                        <section className="space-y-2">
                          <h3 className="text-xs font-semibold uppercase tracking-wide text-orange-700">
                            Ingredient changes
                          </h3>
                          <ul className="space-y-2 text-sm leading-relaxed text-neutral-700">
                            {ingredients.map((x, i) => (
                              <li
                                key={i}
                                className="border-l-2 border-orange-400/80 pl-3"
                              >
                                {x}
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                      {steps.length > 0 && (
                        <section className="space-y-2">
                          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600">
                            Step improvements
                          </h3>
                          <ul className="space-y-2 text-sm leading-relaxed text-neutral-600">
                            {steps.map((x, i) => (
                              <li
                                key={i}
                                className="border-l-2 border-neutral-300 pl-3"
                              >
                                {x}
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Footer */}
            <footer className="space-y-3 border-t border-neutral-100 pt-4">
              <p className="text-center text-xs text-neutral-500">
                Based on{" "}
                <span className="font-medium text-neutral-700">
                  {sourceCount} source{sourceCount === 1 ? "" : "s"}
                </span>
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
                <button
                  type="button"
                  onClick={handleViewRecipe}
                  className="order-1 flex-1 rounded-xl bg-emerald-600 py-3.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.99]"
                >
                  View updated recipe
                </button>
                <Link
                  href="/create"
                  onClick={() => setOpen(false)}
                  className="order-2 flex flex-1 items-center justify-center rounded-xl border border-neutral-200 bg-white py-3.5 text-sm font-medium text-neutral-800 transition hover:bg-neutral-50"
                >
                  Add more sources
                </Link>
              </div>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
