# Recipe Cloud — Flow & architecture documentation

This document describes how the app works end-to-end, with emphasis on **four-phase corpus synthesis**, **`source_extractions`**, **Recipe Builder (extension)**, **merge diffs**, and **recipe page UX**.

---

## 1. Product overview

**Recipe Cloud** saves recipes by:

- Pasting **one or more URLs** and/or **images** on **`/create`**.
- Using the **Chrome extension** as a **Recipe Builder**: capture the current page, then **add more pages** to the same recipe.

### Source history (parallel arrays)

| Field | Role |
|-------|------|
| **`sources[]`** | Label per capture (URL, `image:N`, or platform) |
| **`raw_texts[]`** | Raw text for that capture (same index as `sources`) |
| **`source_extractions[]`** | JSON array (optional): per-source **Phase A** output + **`source_url`**, **`source_type`**, **`raw_text`** snippet — aligned by index with **`sources`/`raw_texts`** |

**Corpus string:** `raw_texts.join("\n\n---\n\n")` — **`RAW_TEXT_JOINER`** in **`recipeSourceHistory.ts`**.

**Legacy:** rows with only **`raw_text`** → **`hydrateRecipeSourceHistory`** backfills one chunk and aligns **`sources`** from **`source_urls`**.

### Synthesis entrypoints (`recipeSynthesis.ts`)

| Function | Use |
|----------|-----|
| **`synthesizeRecipeFromCombinedRaw`** | Returns final **`SynthesisDbPayload`** only. |
| **`synthesizeRecipeFromCombinedRawWithExtractions`** | Returns **`payload`** + **`source_extractions`** for DB (create + extension merge). |
| **`synthesizeRecipeFromVersions`** | Same 4-phase pipeline on **synthetic chunks** from structured **`ExtractedRecipe`** rows (**`mergeRecipesIntelligent`** fallback). |

Full re-synthesis uses **all** **`raw_texts[]`** (not incremental). Phases: **§6.1**. On successful corpus save, **`source_extractions`** is written; on structured-merge fallback after an empty corpus result, it may be **cleared** (`null`).

### Web create (`POST /api/recipes/create`)

1. Parallel ingest → append **`historySources[]`** + **`historyRawTexts[]`** per successful source (raw page text, or text derived from **`ExtractedRecipe`** when thin).
2. **`combinedText = join(historyRawTexts)`** → **`synthesizeRecipeFromCombinedRawWithExtractions`** with **`{ sources, raw_texts }`** so Phase A stays per-source.
3. If payload is empty / unusable → **`mergeRecipesIntelligent`** (4-phase on version blobs); **`needs_review: true`**; **`source_extractions`** may be omitted or cleared.
4. Insert row: body + **`sources`**, **`raw_texts`**, optional **`source_extractions`**.

### Extension (`POST /api/extract-from-extension`)

| Mode | Behavior |
|------|----------|
| **New** | Single source → phased synthesis (or weak draft / **`extractRecipe`** if disabled/short input). |
| **Merge** | Append **`sources`/`raw_texts`** → **`WithExtractions`** → on success **replace** body + **`source_extractions`**; **`last_diff`** + **`versions`**. |
| **Failure** | Append history only; **`needs_review: true`**; **do not** overwrite ingredients/steps/tips. |

### Recipe diff (merge success only)

| Step | What runs |
|------|-----------|
| 1 | **`previousRecipe`** = DB row before update. |
| 2 | **`nextRecipe`** = synthesized payload. |
| 3 | **`diffRecipes`** — structural diff (ingredients, steps, tips, etc.). |
| 4 | **`summarizeRecipeDiffWithAi`** — **`summary`** + **≤5** **`key_improvements[]`** (material changes only). If AI returns nothing → **`heuristicDiffSummary`**. |
| 5 | **`last_diff`**; **`versions[]`** prepend (cap **10**). |

**UI:** Extension post-merge screen; **`RecipeUpdatedModal`** (`?updated=`); recipe page **Recently improved** + **`lastDiff`**; expandable **versions** + source URLs.

---

## 2. Tech stack (reference)

| Layer | Technology |
|-------|------------|
| Web | Next.js 14 (App Router), TypeScript, Tailwind |
| DB | Supabase (Postgres) |
| Synthesis | **`recipeSynthesisPhased.ts`** (A–D); **`recipeSynthesis.ts`** |
| Ingredients | **`ingredientNormalize.ts`** (Phase C dedupe) |
| History | **`recipeSourceHistory.ts`** |
| Diff | **`recipeDiff.ts`**, **`recipeDiffAi.ts`** |
| Merge fallback | **`aiMerge.ts`**, **`structuredSteps.ts`** |
| Ingest | **`sourcePipeline.ts`**, **`websiteExtract.ts`**, **`aiExtractor.ts`** |
| UI | **`RecipeView.tsx`**, **`RecipeUpdatedModal.tsx`** |
| AI | OpenAI **`gpt-4o-mini`** |
| Extension | Chrome MV3 |

---

## 3. User-facing entry points

### 3.1 Create (`/create`)

**`POST /api/recipes/create`** — multi-source ingest → phased corpus save → draft or **`mergeRecipesIntelligent`** fallback.

### 3.2 Dashboard (`/dashboard`)

List by **`updated_at`**; **`DELETE /api/recipes/[id]`**.

### 3.3 Recipe (`/recipe/[id]`)

**Layout:** **`max-w-[720px]`**, **`space-y-6`**, cards + soft shadows.

| Block | Content |
|-------|---------|
| **Hero** | Title, **summary** (`description`), metadata (time, servings, source count). |
| **Alerts** | **`needs_review`**, empty-state CTA, **Recently improved** → diff modal. |
| **Servings** | − / + ; **core + optional** scaled the same (**`scaleIngredients`**). |
| **Core** | Essential ingredients (deduped display). |
| **Optional & customize** | Optional lines. |
| **Substitutions** | **`ingredient` → `options`**, optional **`note`**. |
| **Start cooking** | Scroll to **`#recipe-steps`**. |
| **Steps** | Number, title, time/tools, instructions, **`warnings`**. |
| **Tips** | Flat list if non-empty (no mistakes/techniques sections in UI). |
| **History** | “Updated from *N* sources” + **`versions[]`**; collapsible source URLs. |

**Data freshness:** **`unstable_noStore()`** in recipe loader so merges from the extension show the latest row. Extension opens **`/recipe/{id}?updated=…&cb=…`** to avoid stale tab cache.

**No extra client API calls** for scaling.

### 3.4 Extension

Picker → **Add this page** → **`POST /api/extract-from-extension`**. ~5k DOM chars. **View recipe** uses cache-bust query params.

---

## 4. Link classification (`classifyLink`)

YouTube → `youtube`; TikTok / IG / FB / XHS → `reel_fallback`; else **`html_parse`**.

---

## 5. Per-source extraction (ingest, not synthesis Phase A)

**`ExtractedRecipe`**, **`StructuredIngredient`**. Blogs: JSON-LD **`Recipe`** may skip OpenAI. See **`websiteExtract.ts`**, **`sourcePipeline.ts`**, **`aiExtractor.ts`**.

**Synthesis Phase A** (different): model reads each **`raw_texts[i]`** block and emits **candidate lists** only — stored in **`source_extractions[i]`** when synthesis succeeds.

---

## 6. Corpus synthesis & fallbacks

### 6.1 Four phases (`recipeSynthesisPhased.ts`)

| Phase | Output |
|-------|--------|
| **A** | Per source: **`ingredient_candidates`**, **`step_candidates`**, **`tip_candidates`** (no final recipe decisions). |
| **B** | **Dish profile:** canonical name, cuisine, **essentials**, acceptable optionals. |
| **C** | **Core / optional / substitutions** (+ dedupe); retries if essentials missing or misplaced. |
| **D** | **Steps** (banded count by complexity), **`summary`**, **`tips`** (≤6), **`servings`**, step **`warnings`**. Retry if steps don’t align with ingredient names. |

**Saved shape:** **`description`** = summary; **`mistakes`/`techniques`** → **`[]`** on new synth; substitutions **`{ ingredient, options, note? }`**.

**Calls:** ~**4–6** OpenAI JSON completions per full run (plus retries).

### 6.2 Fallback: `mergeRecipesIntelligent`

When corpus phased synthesis is **null** or yields an empty body: build chunks from **`ExtractedRecipeWithConfidence[]`**, run the **same 4-phase** via **`synthesizeRecipeFromVersions`**.

### 6.3 `mergedOutputToDbRow` / `synthesisPayloadToMerged`

Map **`SynthesisDbPayload`** → DB columns (**`aiMerge.ts`**).

---

## 7. Extension merge (sequence)

1. **`mergeSources`** → **`source_urls`**, **`source_platforms`**.
2. Append **`sources`**, **`raw_texts`**.
3. **`synthesizeRecipeFromCombinedRawWithExtractions`**.
4. **Success:** full UPDATE (body + **`source_extractions`**) + **`last_diff`** + **`versions`**, **`needs_review: false`**.
5. **Failure:** history-only UPDATE, **`needs_review: true`**, body unchanged.

---

## 8. API routes (summary)

| Route | Purpose |
|-------|---------|
| `GET /api/recipes?limit=5` | Extension picker |
| `DELETE /api/recipes/[id]` | Delete |
| `POST /api/recipes/create` | Multi-source create |
| `POST /api/extract-from-extension` | Create / merge |
| `POST /api/extract` | Debug |
| `POST /api/merge` | JSON merge |

---

## 9. Database (`recipes`)

| Column | Role |
|--------|------|
| **`ingredients`**, **`steps`**, **`tips`**, **`substitutions`**, **`servings`**, **`servings_base`**, **`description`**, **`estimated_time`** | Main body |
| **`mistakes`**, **`techniques`** | Legacy columns; **empty arrays** on new synthesis |
| **`source_urls`**, **`source_platforms`**, **`raw_text`**, **`sources`**, **`raw_texts`**, **`source_extractions`** | Provenance + Phase A snapshot |
| **`needs_user_input`**, **`needs_review`** | Draft / failed re-synth |
| **`last_diff`**, **`versions`** | Merge UX + history |

Migrations: chain from **`create_recipes`** through **`recipe_last_diff`**; add **`source_extractions`** via **`20250325000000_source_extractions.sql`**.

---

## 10. Environment

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, **`OPENAI_API_KEY`**.

---

## 11. Log prefixes

`[extract]`, `[pipeline]`, `[OpenAI]`, `[synthesis-phased]`, **`[recipeDiffAi]`**, **`[extract-from-extension]`**, `[merge]`.

---

## 12. Diagrams

### Web create

```text
ingest (parallel)
      → historySources[] + historyRawTexts[]
      → synthesizeRecipeFromCombinedRawWithExtractions
            Phase A → B → C → D
      ├─► OK → insert (body + source_extractions + sources + raw_texts)
      └─► empty/fail → mergeRecipesIntelligent (4-phase on structured rows)
                      → needs_review if applicable; source_extractions may be null
```

### Four-phase synthesis (detail)

```text
raw_texts[] (per-source chunks)
      ▼
Phase A ──► per-source candidate lists (ing / step / tip)
      ▼
Phase B ──► dish profile (essentials, cuisine, …)
      ▼
Phase C ──► core, optional, substitutions (+ dedupe / retries)
      ▼
Phase D ──► steps + summary + tips + servings (+ step validation retry)
      ▼
SynthesisDbPayload → DB
```

### Extension merge

```text
append sources/raw_texts
      ▼
WithExtractions (A→D)
      ├─► success → REPLACE body + source_extractions + last_diff + versions
      └─► fail → append history only, needs_review, body unchanged
```

### Recipe page

```text
getRecipe(id) + noStore()
      ▼
RecipeView: memo scale (core + optional) · dedupe display
      ▼
No client fetch for recipe JSON
```

---

## 13. Future-friendly

Auth / RLS, platform APIs, mobile share, grocery lists.

---

*Last updated: **four-phase** `recipeSynthesisPhased` (A–D); **`source_extractions`** + **`WithExtractions`** on create/extension; **recipe page** hierarchy, **`warnings`**, tips-only extras, **`noStore`** + extension cache-bust; **diff** summaries capped and noise-filtered; diagrams aligned.*
