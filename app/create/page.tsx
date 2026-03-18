"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LinkInput } from "@/components/LinkInput";
import { LoadingState } from "@/components/LoadingState";

const LOADING_STEP_INTERVAL = 2000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function CreatePage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [urls, setUrls] = useState<string[]>([""]);
  const [images, setImages] = useState<string[]>([]);
  const [dishName, setDishName] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fallbackMode, setFallbackMode] = useState(false);
  const [fallbackTitle, setFallbackTitle] = useState("");
  const [fallbackIngredients, setFallbackIngredients] = useState("");
  const [fallbackSteps, setFallbackSteps] = useState("");
  const [fromReel, setFromReel] = useState(false);
  const [resultSummary, setResultSummary] = useState<{
    recipeId: string;
    from_reel: boolean;
    sources: {
      source_url: string;
      platform: string;
      status: string;
      error?: string;
    }[];
    extracted_count: number;
    total_count: number;
  } | null>(null);
  const [failedSources, setFailedSources] = useState<
    { source_url: string; platform: string; status: string; error?: string }[]
  >([]);

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

  async function addImage(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length) return;
    const remaining = MAX_IMAGES - images.length;
    const added: string[] = [];
    for (let i = 0; i < Math.min(files.length, remaining); i++) {
      const file = files[i];
      if (!file.type.startsWith("image/") || file.size > MAX_IMAGE_BYTES)
        continue;
      try {
        const b64 = await fileToBase64(file);
        added.push(b64);
      } catch {
        /* ignore */
      }
    }
    if (added.length > 0) {
      setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES));
    }
    e.target.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  const validUrls = urls.map((u) => u.trim()).filter(Boolean);
  const canSubmit = validUrls.length > 0 || images.length > 0;

  async function handleSubmit() {
    if (!canSubmit) {
      setError("Add at least one link or image.");
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
        body: JSON.stringify({
          urls: validUrls,
          images: images.length > 0 ? images : undefined,
          dish_name: dishName || undefined,
        }),
      });
      clearInterval(stepTimer);
      setLoadingStep(4);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 422) {
          setFromReel(!!data.has_reel_input);
          setFallbackMode(true);
          const src = Array.isArray(data.sources) ? data.sources : [];
          setFailedSources(src);
          const x = data.extracted_count ?? 0;
          const y = data.total_count ?? src.length;
          const prefix =
            y > 0
              ? `We extracted ${x} of ${y} sources. `
              : "";
          setError(
            prefix +
              (data.error ||
                "Complete the recipe below using your best notes from the links.")
          );
        } else {
          setError(data.error || "Something went wrong.");
        }
        setLoading(false);
        return;
      }
      if (data.id) {
        setLoading(false);
        setResultSummary({
          recipeId: data.id,
          from_reel: !!data.from_reel,
          sources: Array.isArray(data.sources) ? data.sources : [],
          extracted_count: data.extracted_count ?? 1,
          total_count: data.total_count ?? 1,
        });
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

  if (resultSummary) {
    const q = resultSummary.from_reel ? "?from_reel=1" : "";
    return (
      <div className="min-h-screen bg-[#fafafa] px-4 py-10">
        <div className="mx-auto max-w-lg">
          <Link
            href="/"
            className="text-sm font-medium text-neutral-600 hover:text-neutral-900"
          >
            ← Recipe Cloud
          </Link>
          <h1 className="mt-6 text-xl font-semibold text-neutral-900">
            Recipe saved
          </h1>
          <p className="mt-2 text-neutral-600">
            We extracted{" "}
            <strong>
              {resultSummary.extracted_count} of {resultSummary.total_count}
            </strong>{" "}
            sources.
          </p>
          {resultSummary.sources.length > 0 && (
            <ul className="mt-4 space-y-2 rounded-2xl border border-neutral-100 bg-white p-4 shadow-sm">
              {resultSummary.sources.map((s, i) => (
                <li
                  key={i}
                  className="flex flex-col gap-0.5 border-b border-neutral-50 pb-2 text-sm last:border-0 last:pb-0"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        s.status === "success"
                          ? "text-green-600"
                          : "text-red-500"
                      }
                    >
                      {s.status === "success" ? "✓" : "✗"}
                    </span>
                    <span className="truncate font-medium text-neutral-800">
                      {s.source_url.length > 48
                        ? s.source_url.slice(0, 46) + "…"
                        : s.source_url}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-400">
                      {s.platform}
                    </span>
                  </div>
                  {s.status === "failed" && s.error && (
                    <p className="ml-6 text-xs text-neutral-500">{s.error}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() =>
              router.push(`/recipe/${resultSummary.recipeId}${q}`)
            }
            className="mt-6 w-full rounded-2xl bg-neutral-900 py-3 text-sm font-medium text-white hover:bg-neutral-800"
          >
            Open recipe
          </button>
        </div>
      </div>
    );
  }

  if (fallbackMode) {
    return (
      <div className="min-h-screen bg-[#fafafa]">
        <header className="border-b border-neutral-100 bg-white">
          <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-4">
            <Link
              href="/"
              className="text-lg font-semibold text-neutral-900"
            >
              Recipe Cloud
            </Link>
          </div>
        </header>
        <main className="mx-auto max-w-2xl px-4 py-10">
          {fromReel && (
            <p className="mb-4 rounded-xl bg-amber-50 px-4 py-2 text-sm text-amber-800">
              We created this recipe from a short video. You can edit the details
              below.
            </p>
          )}
          <h2 className="text-xl font-semibold text-neutral-900">
            Help us complete this recipe
          </h2>
          {error && (
            <p className="mt-2 text-sm text-amber-700">{error}</p>
          )}
          {failedSources.length > 0 && (
            <ul className="mt-4 space-y-2 rounded-xl border border-neutral-200 bg-white p-3 text-sm">
              {failedSources.map((s, i) => (
                <li key={i} className="text-neutral-600">
                  <span className="text-red-500">✗</span>{" "}
                  <span className="truncate">{s.source_url}</span>
                  {s.error && (
                    <span className="block pl-4 text-xs text-neutral-500">
                      {s.error}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700">
                Dish name (optional)
              </label>
              <input
                type="text"
                value={fallbackTitle}
                onChange={(e) => setFallbackTitle(e.target.value)}
                placeholder="e.g. Bún Bò Huế"
                className="mt-1 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-neutral-900 focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-200"
              />
            </div>
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
                  setFailedSources([]);
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
                      fallback: {
                        title: fallbackTitle || "Untitled Recipe",
                        ingredients,
                        steps,
                      },
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
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#fafafa] px-4 py-12">
      <Link
        href="/"
        className="absolute left-4 top-4 text-sm font-medium text-neutral-600 hover:text-neutral-900"
      >
        ← Recipe Cloud
      </Link>
      <h1 className="text-2xl font-semibold text-neutral-900">
        Drop your recipe links or images
      </h1>
      <p className="mt-1 text-center text-sm text-neutral-500">
        Paste URLs (blogs, YouTube, Instagram, TikTok, etc.) or upload
        screenshots
      </p>

      <div className="mt-8 w-full max-w-lg space-y-6">
        <div className="space-y-3">
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

        <div>
          <label className="block text-sm font-medium text-neutral-600">
            Or add screenshots (optional)
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={addImage}
            className="sr-only"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-2 flex w-full items-center justify-center rounded-2xl border border-dashed border-neutral-200 bg-white py-6 text-sm text-neutral-500 hover:border-neutral-300 hover:bg-neutral-50"
          >
            {images.length > 0
              ? `${images.length} image(s) added · Click to change`
              : "Click or drop images (max 4)"}
          </button>
          {images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div
                  key={i}
                  className="relative h-16 w-16 overflow-hidden rounded-lg bg-neutral-100"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- base64 data URL preview */}
                  <img
                    src={img}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(i)}
                    className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-neutral-600">
            What dish is this? (optional)
          </label>
          <input
            type="text"
            value={dishName}
            onChange={(e) => setDishName(e.target.value)}
            placeholder="e.g. Bún Bò Huế"
            className="mt-1 w-full rounded-2xl border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-200"
          />
        </div>
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-600">{error}</p>
      )}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="mt-8 rounded-2xl bg-neutral-900 px-8 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50"
      >
        Create Recipe
      </button>
    </div>
  );
}
