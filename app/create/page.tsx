"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LinkInput } from "@/components/LinkInput";
import { LoadingState } from "@/components/LoadingState";

const LOADING_STEP_INTERVAL = 2000;

export default function CreatePage() {
  const router = useRouter();
  const [urls, setUrls] = useState<string[]>([""]);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fallbackMode, setFallbackMode] = useState(false);
  const [fallbackIngredients, setFallbackIngredients] = useState("");
  const [fallbackSteps, setFallbackSteps] = useState("");

  function addLink() {
    setUrls((prev) => [...prev, ""]);
  }

  function updateUrl(index: number, value: string) {
    setUrls((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  function removeLink(index: number) {
    if (urls.length <= 1) return;
    setUrls((prev) => prev.filter((_, i) => i !== index));
  }

  const validUrls = urls.map((u) => u.trim()).filter(Boolean);

  async function handleSubmit() {
    if (validUrls.length === 0) {
      setError("Paste at least one link.");
      return;
    }
    setError(null);
    setLoading(true);
    setLoadingStep(0);
    const stepTimer = setInterval(() => {
      setLoadingStep((s) => Math.min(s + 1, 3));
    }, LOADING_STEP_INTERVAL);

    try {
      const res = await fetch("/api/recipes/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: validUrls }),
      });
      clearInterval(stepTimer);
      setLoadingStep(4);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 422) {
          setFallbackMode(true);
          setError(
            data.error || "We couldn’t extract a full recipe. You can complete it below."
          );
        } else {
          setError(data.error || "Something went wrong.");
        }
        setLoading(false);
        return;
      }
      if (data.id) {
        router.push(`/recipe/${data.id}`);
        return;
      }
      setError("No recipe ID returned.");
    } catch (e) {
      clearInterval(stepTimer);
      setError("Network error. Try again.");
    }
    setLoading(false);
  }

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#fafafa] px-4">
        <LoadingState step={loadingStep} />
      </div>
    );
  }

  if (fallbackMode) {
    return (
      <div className="min-h-screen bg-[#fafafa]">
        <header className="border-b border-neutral-100 bg-white">
          <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-4">
            <Link href="/" className="text-lg font-semibold text-neutral-900">
              Recipe Cloud
            </Link>
          </div>
        </header>
        <main className="mx-auto max-w-2xl px-4 py-10">
          <h2 className="text-xl font-semibold text-neutral-900">
            Help us complete this recipe
          </h2>
          {error && (
            <p className="mt-2 text-sm text-amber-700">{error}</p>
          )}
          <div className="mt-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700">
                Ingredients (one per line)
              </label>
              <textarea
                value={fallbackIngredients}
                onChange={(e) => setFallbackIngredients(e.target.value)}
                rows={6}
                className="mt-1 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-neutral-900 focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-200"
                placeholder="e.g. 2 cups flour&#10;1 tsp salt"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700">
                Steps (one per line)
              </label>
              <textarea
                value={fallbackSteps}
                onChange={(e) => setFallbackSteps(e.target.value)}
                rows={8}
                className="mt-1 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-neutral-900 focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-200"
                placeholder="e.g. Preheat oven to 350°F&#10;Mix dry ingredients..."
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setFallbackMode(false);
                  setError(null);
                }}
                className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={async () => {
                  const ingredients = fallbackIngredients
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  const steps = fallbackSteps
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  const res = await fetch("/api/recipes/create", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      urls: validUrls,
                      fallback: { title: "Untitled Recipe", ingredients, steps },
                    }),
                  });
                  const data = await res.json().catch(() => ({}));
                  if (data.id) router.push(`/recipe/${data.id}`);
                  else setError(data.error || "Failed to save.");
                }}
                className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
              >
                Save recipe
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#fafafa] px-4">
      <Link href="/" className="absolute left-4 top-4 text-sm font-medium text-neutral-600 hover:text-neutral-900">
        ← Recipe Cloud
      </Link>
      <h1 className="text-2xl font-semibold text-neutral-900">
        Drop your recipe links
      </h1>
      <div className="mt-8 w-full max-w-lg space-y-3">
        {urls.map((url, i) => (
          <div key={i} className="flex gap-2">
            <LinkInput
              value={url}
              onChange={(v) => updateUrl(i, v)}
              placeholder="Paste link..."
            />
            {urls.length > 1 && (
              <button
                type="button"
                onClick={() => removeLink(i)}
                className="shrink-0 rounded-2xl border border-neutral-200 bg-white px-3 text-neutral-500 hover:bg-neutral-50"
                aria-label="Remove link"
              >
                −
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={addLink}
          className="text-sm font-medium text-neutral-500 hover:text-neutral-700"
        >
          + Add another link
        </button>
      </div>
      {error && (
        <p className="mt-3 text-sm text-red-600">{error}</p>
      )}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={validUrls.length === 0}
        className="mt-8 rounded-2xl bg-neutral-900 px-8 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
      >
        Create Recipe
      </button>
    </div>
  );
}
