# Recipe Cloud — Flow & architecture documentation

This document describes how the app works end-to-end, with emphasis on **content extraction**, **full-corpus re-synthesis**, **Recipe Builder (extension)**, **recipe diffs**, and **when OpenAI runs**.

---

## 1. Product overview

**Recipe Cloud** saves recipes by:

- Pasting **one or more URLs** and/or **images** on **`/create`**.
- Using the **Chrome extension** as a **Recipe Builder**: create from the current page, then **add more pages** to the same recipe.

### Core idea: one chef pass on *all* raw text

Each recipe keeps a **parallel history**:

| Field | Role |
|-------|------|
| **`sources[]`** | Label per capture (usually URL or `image:N`) |
| **`raw_texts[]`** | Raw text captured for that source (same length as `sources`) |

**Combined corpus:** `raw_texts.join("\n\n---\n\n")` (constant `RAW_TEXT_JOINER` in `recipeSourceHistory.ts`).

**Primary synthesis:** **`synthesizeRecipeFromCombinedRaw`** (`recipeSynthesis.ts`) — **stage 1** extracts candidate ingredient/step/tip lines from the full corpus; **stage 2** chef **decides** the single best recipe (not a summary of everything). **Not** incremental merge of “old row + last page only.”

**Legacy rows** without `raw_texts`: **`hydrateRecipeSourceHistory`** treats legacy **`raw_text`** as a single chunk and aligns `sources` from **`source_urls`** where possible.

### Web create (`POST /api/recipes/create`)

1. Per URL/image: ingest → for each success, append **`historySources`** + **`historyRawTexts`** (raw from page, or **structured fallback text** from `ExtractedRecipe` if raw is thin).
2. **Raw-only successes** (no structured recipe but have text): still get corpus rows; draft or **`synthesizeRecipeFromCombinedRaw`** only.
3. **`combinedText = historyRawTexts.join(RAW_TEXT_JOINER)`** → **`synthesizeRecipeFromCombinedRaw`**.
4. If corpus output is empty → **`mergeRecipesIntelligent(successfulRecipes)`** ( **`synthesizeRecipeFromVersions`** inside + fallbacks).
5. Persist **`sources`**, **`raw_texts`**, **`needs_review`** when AI fallback used; draft when nothing usable.

### Extension (`POST /api/extract-from-extension`)

- **New recipe:** `sources = [url|platform]`, `raw_texts = [raw_text]` → same combined synthesis (or draft / `extractRecipe` fallback).
- **Merge (`recipeId`):** append to **`sources`** / **`raw_texts`** → **full** re-synthesis from joined corpus → **overwrite** recipe fields on success.
- **AI failure:** **do not** overwrite ingredients/steps/tips; still append history; set **`needs_review`**. UI shows a **needs review** banner.

### Recipe diff (successful merge only)

1. **`previousRecipe = recipeFromDbRow(row)`** (before update).
2. **`nextRecipe`** from new synthesis payload.
3. **`diffRecipes(prev, next)`** (`recipeDiff.ts`) — ingredients (normalized keys), core↔optional moves, steps (token Jaccard), tips/mistakes/techniques.
4. **`summarizeRecipeDiffWithAi`** (`recipeDiffAi.ts`) — **`summary`** + **`key_improvements[]`** themed on **authenticity, technique, flavor** (not raw ingredient/step lists) + heuristic fallback → **`last_diff`**; **`versions[]`** prepends compact entries (max **10**).
5. Extension: **“Recipe updated”** modal. Web: **`RecipeUpdatedModal`** when opening **`/recipe/[id]?updated=…`**. Recipe page: collapsible **Source update history**.

---

## 2. Tech stack (reference)

| Layer | Technology |
|-------|------------|
| Web app | Next.js 14 (App Router), TypeScript |
| Styling | TailwindCSS |
| Database | Supabase (Postgres) |
| Ingredient math | `ingredientParser.ts`, `ingredientScale.ts` |
| **Corpus synthesis** | **`recipeSynthesis.ts`** — **`synthesizeRecipeFromCombinedRaw`** (+ **`synthesizeRecipeFromVersions`** for structured multi-version path) |
| Source history | **`recipeSourceHistory.ts`** — hydrate / joiner |
| **Recipe diff** | **`recipeDiff.ts`**, **`recipeDiffAi.ts`** |
| Structured steps | **`structuredSteps.ts`** |
| Merge / fallback | **`aiMerge.ts`** — synthesis + chef + overlap fallback |
| AI | OpenAI (`gpt-4o-mini`) |
| Blog HTML | Cheerio, Readability, JSDOM |
| Extension | Chrome MV3 |
| Deploy | Vercel (typical) |

---

## 3. User-facing entry points

### 3.1 Web: Create recipe (`/create`)

1. User adds URLs and/or images; optional dish name.
2. **`POST /api/recipes/create`** — parallel ingest (`Promise.allSettled`).
3. **Success:** corpus synthesis first; response includes **`id`**, source reports, counts.
4. **Draft:** no structured success and corpus synthesis didn’t produce a full recipe — still returns **`id`**, **`is_draft: true`** when applicable.

### 3.2 Web: Dashboard (`/dashboard`)

- **`updated_at` DESC**; delete → **`DELETE /api/recipes/[id]`** + **`revalidatePath('/dashboard')`**.

### 3.3 Web: Recipe view (`/recipe/[id]`)

- Core / optional ingredients, substitutions, structured steps, tips, mistakes, techniques, scaling.
- **`needs_user_input`:** draft CTA.
- **`needs_review`:** banner when a new source was stored but re-synthesis failed.
- **`last_diff`:** **`summary`** + **what improved** bullets (`key_improvements`); modal when URL has **`?updated=`**.
- **`versions[]`:** **Source update history** (summaries per merge).

### 3.4 Chrome extension

**Storage:** active recipe id/title/source count.

**Flow:** pick target → **Add this page** → **`POST /api/extract-from-extension`**.

| After merge success | UI |
|---------------------|-----|
| **`last_diff` present | **Recipe updated** (summary + key improvements: authenticity / technique / flavor) → **Continue** → success view |
| Always | **View recipe** opens **`/recipe/{id}?updated={timestamp}`** (cache-bust) |

**Capture:** visible text from article-like nodes; cap ~5000 chars; **`raw_text`**, **`source_url`**, **`platform`**.

---

## 4. Link classification (`lib/classifyLink.ts`)

| Platform | Strategy |
|----------|----------|
| YouTube | `youtube` |
| TikTok, IG, FB, XHS | `reel_fallback` |
| Default | `html_parse` |

---

## 5. Per-source extraction (websites, YouTube, reels, images)

Same as before: **`ExtractedRecipe`** with **`StructuredIngredient`**; JSON-LD bypass on blogs when schema is complete. See **`websiteExtract.ts`**, **`sourcePipeline.ts`**, **`aiExtractor.ts`**. Success when **ingredients OR steps** (or raw text for corpus-only path on create).

---

## 6. Corpus synthesis & fallbacks

### 6.1 `synthesizeRecipeFromCombinedRaw` (primary for full history)

**Input:** all **`raw_texts`** joined by **`\n\n---\n\n`**.

**Two-stage (decision-based, not summarization):**

1. **Stage 1 — extract candidates** — JSON: **`ingredient_candidates[]`**, **`step_candidates[]`**, **`tip_candidates[]`** (exhaustive capture from raw; no merging). If lists stay empty, stage 1 retries once; chef stage can still see a raw excerpt.
2. **Stage 2 — chef decision** — One authoritative recipe: core vs optional vs substitutions by **culinary judgment** (explicitly **not** frequency-based); steps rewritten from scratch using **only** finalized ingredients; tips / mistakes / techniques.
3. **Validation** — Fails if: many step tokens are not covered by any ingredient line; too many **core** items never mentioned in steps; empty core when stage 1 listed many ingredients. **One retry** of stage 2 with validation feedback. If still failing, **best-effort** result is returned (logged).

**Output:** same JSON shape as version synthesis. Empty-output quality retry remains before validation.

### 6.2 `synthesizeRecipeFromVersions` + `mergeRecipesIntelligent`

Used when:

- Create path: corpus synthesis returns empty structured recipe → fallback on **`ExtractedRecipeWithConfidence[]`**.
- Legacy **`/api/merge`** and internal chef path.

### 6.3 `mergedOutputToDbRow` / `synthesisPayloadToMerged`

Maps synthesis output → DB columns.

---

## 7. Extension API — merge algorithm (detailed)

**`POST /api/extract-from-extension`**

| Body field | Role |
|------------|------|
| `raw_text`, `source_url`, `platform` | New capture |
| `recipeId` | Merge into existing row |
| `recipe_name` | New recipe title hint |

**Merge steps:**

1. Load row; **`mergeSources`** updates **`source_urls`** / **`source_platforms`** (unique URLs).
2. **`hydrateRecipeSourceHistory(row)`** → append new label + **`raw_text`** to **`sources`** / **`raw_texts`**.
3. **`combinedText = raw_texts.join(RAW_TEXT_JOINER)`** (truncated safely for DB).
4. **`synthesizeRecipeFromCombinedRaw`**.
5. **Success:** UPDATE all recipe fields + **`sources`**, **`raw_texts`**, **`raw_text`**, **`needs_review: false`**, compute **`diffRecipes` + AI summary** → **`last_diff`**, push **`versions`**, **`updated_at`**.
6. **Failure:** UPDATE only **`sources`**, **`raw_texts`**, **`raw_text`**, URLs/platforms, **`needs_review: true`** — **ingredients/steps/tips unchanged**.

**Logging:** source count before/after, **`combinedLen`**, short AI outcome line.

---

## 8. Other API routes

| Route | Role |
|-------|------|
| `GET /api/recipes?limit=5` | Extension picker |
| `DELETE /api/recipes/[id]` | Delete |
| `POST /api/recipes/create` | Multi-source create (corpus-first) |
| `POST /api/extract-from-extension` | Extension create/merge; response may include **`last_diff`**, **`recipe`**, **`synthesisFailed`** |
| `POST /api/extract` | Debug single URL |
| `POST /api/merge` | JSON array merge (structured merge path) |

---

## 9. Database (`recipes`)

| Column | Role |
|--------|------|
| **`ingredients`** | `{ core[], optional[] }` — `StructuredIngredient` |
| **`steps`** | `RecipeStep[]` |
| **`tips`**, **`mistakes`**, **`techniques`** | string[] |
| **`substitutions`** | `{ original, alternatives[] }[]` |
| **`servings`**, **`servings_base`** | Display + scale base |
| **`source_urls`**, **`source_platforms`** | Provenance (URLs unique in merge helper) |
| **`raw_text`** | Legacy / combined blob mirror (large cap) |
| **`sources`**, **`raw_texts`** | **Parallel capture history** (jsonb arrays) |
| **`needs_user_input`** | Draft / weak capture |
| **`needs_review`** | New source saved; synthesis failed |
| **`last_diff`** | Structured diff + **`summary`** + **`key_improvements[]`** (AI: authenticity, technique, flavor) |
| **`versions`** | Rolling history of merge summaries (max 10) |
| **`created_at`**, **`updated_at`** | Timestamps |

Apply migrations in order through **`recipe_last_diff`** (sources/raw_texts/needs_review in earlier migration).

---

## 10. Environment variables

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `OPENAI_API_KEY`

---

## 11. Debugging (server logs)

| Prefix | Meaning |
|--------|---------|
| `[extract]` | Website fetch / JSON-LD |
| `[pipeline]` | Per-source ingest |
| `[OpenAI]` | Extract JSON |
| `[synthesis]` | `synthesizeRecipeFromVersions` errors |
| **`[synthesis-from-raw]`** | **`synthesizeRecipeFromCombinedRaw`** errors |
| **`[recipeDiffAi]`** | AI diff errors |
| **`[extract-from-extension]`** | Merge / corpus / diff |
| `[merge]` | Chef / fallback merge |

---

## 12. Mental model (diagrams)

### Web create

```text
URLs + images
      │
      ▼
Promise.allSettled → per source: raw + optional ExtractedRecipe
      │
      ▼
historySources[] + historyRawTexts[]  (parallel)
      │
      ├─► 0 usable chunks ──► DRAFT (+ partial raw if any)
      └─► ≥1 chunk
              │
              ▼
      combinedText = join(raw_texts, "---")
              │
              ▼
      synthesizeRecipeFromCombinedRaw
              │
              ├─► good JSON ──► save + sources/raw_texts
              └─► empty / fail ──► mergeRecipesIntelligent(structured versions)
      │
      ▼
Supabase
```

### Extension merge

```text
Existing row + new page capture
      │
      ▼
sources.push / raw_texts.push
      │
      ▼
combinedText ──► synthesizeRecipeFromCombinedRaw
      │
      ├─► OK ──► UPDATE full recipe + last_diff + versions
      └─► FAIL ──► UPDATE history only + needs_review (keep old body)
```

---

## 13. Future-friendly

- Stronger platform APIs, Auth / RLS, mobile share, grocery lists

---

*Last updated: **corpus-first synthesis** (`synthesizeRecipeFromCombinedRaw`); **`sources` / `raw_texts`** history; extension **failure safety** (`needs_review`); **recipe diff** (`last_diff`, `versions`); extension **Recipe updated** modal + web **`?updated=`** modal; docs aligned with `recipeSourceHistory`, `recipeDiff`, `recipeDiffAi`.*
