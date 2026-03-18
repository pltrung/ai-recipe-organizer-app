# Recipe Cloud — Flow & architecture documentation

This document describes how the app works end-to-end, with emphasis on **content extraction**, **two-stage corpus re-synthesis**, **ingredient normalization & semantic grouping**, **Recipe Builder (extension)**, **recipe diffs**, **recipe page UI**, and **when OpenAI runs**.

---

## 1. Product overview

**Recipe Cloud** saves recipes by:

- Pasting **one or more URLs** and/or **images** on **`/create`**.
- Using the **Chrome extension** as a **Recipe Builder**: create from the current page, then **add more pages** to the same recipe.

### Source history (parallel arrays)

| Field | Role |
|-------|------|
| **`sources[]`** | Label per capture (URL, `image:N`, or platform) |
| **`raw_texts[]`** | Raw text for that capture (same index as `sources`) |

**Corpus string:** `raw_texts.join("\n\n---\n\n")` — see **`RAW_TEXT_JOINER`** in **`recipeSourceHistory.ts`**.

**Legacy:** rows with only **`raw_text`** → **`hydrateRecipeSourceHistory`** backfills one chunk and aligns **`sources`** from **`source_urls`**.

### Synthesis: `synthesizeRecipeFromCombinedRaw` (`recipeSynthesis.ts`)

Not incremental “old recipe + one new page.” The model sees the **full** joined corpus (via candidates + chef, see §6). After a successful chef pass, ingredients go through **`applyIngredientPostProcess`** (§6.4) before persistence.

### Web create (`POST /api/recipes/create`)

1. Parallel ingest → per success, append **`historySources[]`** + **`historyRawTexts[]`** (page raw, or text built from **`ExtractedRecipe`** when raw is thin).
2. Raw-only URL success (text but no structured recipe) still contributes to history; may run corpus-only synthesis or draft.
3. **`combinedText = join(historyRawTexts)`** → **`synthesizeRecipeFromCombinedRaw`** (includes ingredient post-process).
4. Empty / weak corpus output → **`mergeRecipesIntelligent(successfulRecipes)`** (**`synthesizeRecipeFromVersions`**, also post-processed) + chef fallbacks.
5. Persist **`sources`**, **`raw_texts`**; **`needs_review`** when falling back to structured merge after failed corpus pass.

### Extension (`POST /api/extract-from-extension`)

| Mode | Behavior |
|------|----------|
| **New** | `sources` / `raw_texts` length 1 → corpus synthesis (or weak draft / **`extractRecipe`** fallback). |
| **Merge** | Append capture → full corpus re-synthesis → **replace** recipe body on success. |
| **Failure** | Append history only; **`needs_review: true`**; **do not** overwrite ingredients/steps/tips. |

### Recipe diff (merge success only)

| Step | What runs |
|------|-----------|
| 1 | **`previousRecipe`** = DB row before update. |
| 2 | **`nextRecipe`** = synthesized payload. |
| 3 | **`diffRecipes`** (`recipeDiff.ts`) — structural diff (ingredients, steps Jaccard, tips/techniques/mistakes). |
| 4 | **`summarizeRecipeDiffWithAi`** (`recipeDiffAi.ts`) → **`summary`** + **`key_improvements[]`** (authenticity, technique, flavor). If the model returns &lt;2 bullets, **heuristic** lines are merged in. |
| 5 | **`last_diff`** = `{ at, source_count_after, summary, key_improvements[], structured }`. **`versions[]`** prepends `{ at, summary, key_improvements[] }` (max **10**). |

**UI:** Extension **Recipe updated** screen; web **`RecipeUpdatedModal`** with **`?updated=`**; recipe page **“Recently improved”** + same modal via **`lastDiff`** prop; **Source update history** (expandable **`versions[]`**).

**Legacy `last_diff`:** rows with old **`ingredient_changes` / `step_changes` / `new_insights`** only → **`parseRecipeFromDb`** rebuilds **`key_improvements`** for display.

---

## 2. Tech stack (reference)

| Layer | Technology |
|-------|------------|
| Web | Next.js 14 (App Router), TypeScript, Tailwind |
| DB | Supabase (Postgres) |
| Corpus synthesis | **`recipeSynthesis.ts`** — two-stage raw path + **`synthesizeRecipeFromVersions`** |
| Ingredient cleanup | **`ingredientNormalize.ts`** — canonical names, unit aliases, dedupe / merge quantities |
| Ingredient AI split | **`ingredientSemanticRefine.ts`** — optional core vs optional re-partition after dedupe |
| History | **`recipeSourceHistory.ts`** |
| Diff | **`recipeDiff.ts`**, **`recipeDiffAi.ts`** |
| Steps / merge | **`structuredSteps.ts`**, **`aiMerge.ts`** |
| Extract | **`sourcePipeline.ts`**, **`websiteExtract.ts`**, **`aiExtractor.ts`** |
| Recipe UI | **`RecipeView.tsx`** (`/recipe/[id]`), **`RecipeUpdatedModal.tsx`** |
| AI | OpenAI **`gpt-4o-mini`** |
| Extension | Chrome MV3 |

---

## 3. User-facing entry points

### 3.1 Create (`/create`)

**`POST /api/recipes/create`** — parallel URL/image ingest → corpus-first save → draft or structured-merge fallback.

### 3.2 Dashboard (`/dashboard`)

List by **`updated_at`**; **`DELETE /api/recipes/[id]`** + **`revalidatePath`**.

### 3.3 Recipe (`/recipe/[id]`)

**Layout:** centered column **`max-w-[720px]`**; premium, scan-friendly spacing (**`space-y-6`**, rounded cards, soft shadows).

| Area | Behavior |
|------|----------|
| **Hero** | Title, subtitle/description, metadata row (total time, servings, source count). |
| **Servings** | **− / +** controls; scales ingredient quantities client-side (existing scaling); memoized scaled lists. |
| **Ingredients** | Two cards: **Core** / **Optional**; lines like **`10 g sugar`**; client-side dedupe for display consistency. |
| **Substitutions** | Dedicated section (e.g. coffee → espresso, instant coffee). |
| **CTA** | **Start cooking** → scrolls to steps (`#recipe-steps`). |
| **Steps** | Numbered cards: title, instructions, time, tools, goal; generous padding. |
| **Knowledge** | Tabs: **Tips** / **Mistakes** / **Techniques**. |
| **Sources** | “Updated from *N* sources”; expandable **`versions[]`** + source URLs. |
| **Diff** | If **`last_diff`** present: **“Recently improved”** opens **`RecipeUpdatedModal`** (no extra fetch). |
| **Flags** | **`needs_user_input`**, **`needs_review`** banners as before. |

**Performance:** recipe page uses **existing server data only** — no additional API calls for scaling or grouping.

### 3.4 Extension

Picker → **Add this page** → **`POST /api/extract-from-extension`**. After merge: **What improved** ( **`key_improvements`** ) → **Continue** → **View recipe** (`?updated=` cache-bust). DOM capture ~5k chars.

---

## 4. Link classification (`classifyLink`)

YouTube → `youtube`; TikTok / IG / FB / XHS → `reel_fallback`; else → **`html_parse`**.

---

## 5. Per-source extraction

**`ExtractedRecipe`**, **`StructuredIngredient`**. Blogs: JSON-LD **`Recipe`** can bypass OpenAI. Details: **`websiteExtract.ts`**, **`sourcePipeline.ts`**, **`aiExtractor.ts`**.

---

## 6. Corpus synthesis & fallbacks

### 6.1 `synthesizeRecipeFromCombinedRaw` (two-stage)

**Input cap:** ~120k chars of combined raw.

| Stage | Role |
|-------|------|
| **1 — Extract** | JSON: **`ingredient_candidates[]`**, **`step_candidates[]`**, **`tip_candidates[]`** (exhaustive; up to **120** per list). Empty lists → **one retry**. Still empty → stage 2 also receives a **raw excerpt**. |
| **2 — Chef** | Sees formatted candidates (~38k cap). Decides **one** recipe: core / optional / substitutions by **judgment** (not vote-count); steps **only** from finalized ingredients; tips / mistakes / techniques. |
| **QC** | If core+steps empty but input substantial → **retry stage 2** with stricter hint. |
| **Validate** | Fails if: too many step words not covered by ingredient tokens; too many core lines never mentioned in steps; empty core when stage 1 had many ingredient candidates. → **one stage-2 retry** with validation text. Still bad → **best-effort** + log. |
| **Post-process** | **`applyIngredientPostProcess`** (§6.4) on final ingredients. |

**Typical OpenAI calls per invocation:** 2–5 (stage1 + stage2 + optional retries) **+ 0–2** for semantic ingredient refine (§6.4) when **`OPENAI_API_KEY`** is set. Same function backs **web create** and **extension** corpus path.

### 6.2 `synthesizeRecipeFromVersions` + `mergeRecipesIntelligent`

Used when corpus JSON is unusable or create path needs structured merge; also **`/api/merge`**. Output ingredients are **post-processed** the same way (§6.4).

### 6.3 `mergedOutputToDbRow` / `synthesisPayloadToMerged`

Normalize synthesis JSON → DB row shape.

### 6.4 Ingredient post-processing (`ingredientNormalize` + `ingredientSemanticRefine`)

Runs **after** successful synthesis from **`synthesizeRecipeFromCombinedRaw`** and **`synthesizeRecipeFromVersions`**. **Does not change the DB schema** — still **`ingredients.core` / `ingredients.optional`** as JSON.

| Step | Module | What it does |
|------|--------|----------------|
| **Cleaning** | **`ingredientNormalize`** | Lowercase, trim, strip punctuation on names; **`normalizeUnit`** (e.g. tablespoon → tbsp). |
| **Canonical names** | **`normalizeIngredientName`** | Map synonyms to one label (e.g. espresso / strong coffee → coffee; heavy whipping cream → heavy cream; caster / white sugar → sugar; fish sauce / nước mắm → fish sauce). |
| **Dedupe** | **`dedupeIngredientList` / `normalizeAndDedupeGroups`** | Group by normalized name + unit; merge quantities where same unit; prefer stronger units when merging across aliases where applicable. |
| **Semantic split** | **`ingredientSemanticRefine`** (optional) | If **`OPENAI_API_KEY`**: one model call partitions the **flat deduped** list into **core** vs **optional** using **dish knowledge**, not frequency. |
| **Validation** | same file | Reject if duplicates remain in core or core is empty while recipe had several items → **one retry** with fix hint. On failure or no key: keep **deduped** groups only. |

Other code paths (e.g. some draft-only or extractor-only flows) may persist ingredients **without** this pipeline until the next full synthesis.

---

## 7. Extension merge (step-by-step)

1. **`mergeSources`** → **`source_urls`** / **`source_platforms`** (unique URLs).
2. **`hydrateRecipeSourceHistory`** → append **`sources`** / **`raw_texts`**.
3. **`combinedText`** → **`synthesizeRecipeFromCombinedRaw`** (chef → **ingredient post-process**).
4. **OK:** full field UPDATE + **`last_diff`** ( **`summary`**, **`key_improvements`**, **`structured`** ) + **`versions`** + **`needs_review: false`**.
5. **Fail:** UPDATE history + **`needs_review`** only.

**Logs:** sources before/after, **`combinedLen`**, synthesis / validation warnings.

---

## 8. API routes (summary)

| Route | Purpose |
|-------|---------|
| `GET /api/recipes?limit=5` | Extension picker |
| `DELETE /api/recipes/[id]` | Delete |
| `POST /api/recipes/create` | Multi-source create |
| `POST /api/extract-from-extension` | Create / merge; **`last_diff`**, **`recipe`**, **`synthesisFailed`** |
| `POST /api/extract` | Debug |
| `POST /api/merge` | JSON merge |

---

## 9. Database (`recipes`)

| Column | Role |
|--------|------|
| **`ingredients`**, **`steps`**, **`tips`**, **`mistakes`**, **`techniques`**, **`substitutions`**, **`servings`**, **`servings_base`** | Recipe body |
| **`source_urls`**, **`source_platforms`**, **`raw_text`**, **`sources`**, **`raw_texts`** | Provenance + capture history |
| **`needs_user_input`**, **`needs_review`** | Draft / failed re-synth |
| **`last_diff`** | **`summary`**, **`key_improvements[]`**, **`structured`**, **`at`**, **`source_count_after`** |
| **`versions`** | Newest-first entries: **`summary`**, **`key_improvements[]`**, **`at`**, **`source_count_after`** (max **10**) |

Run migrations through **`recipe_last_diff`** (includes **`sources`/`raw_texts`/`needs_review`** from earlier files).

---

## 10. Environment

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, **`OPENAI_API_KEY`**.

---

## 11. Log prefixes

`[extract]`, `[pipeline]`, `[OpenAI]`, `[synthesis]`, **`[synthesis-from-raw]`**, **`[recipeDiffAi]`**, **`[extract-from-extension]`**, **`[ingredientSemanticRefine]`**, `[merge]`.

---

## 12. Diagrams

### Web create

```text
URLs + images → Promise.allSettled (ingest)
      → historySources[] + historyRawTexts[]
      → combinedText
      → synthesizeRecipeFromCombinedRaw (stage1 → stage2 → validate)
      → applyIngredientPostProcess (dedupe + optional AI core/optional)
      → OK: save
      → fail: mergeRecipesIntelligent(structured) → post-process → save / draft
```

### Corpus synthesis (detail)

```text
raw corpus (joined)
      ▼
Stage 1 ──► ingredient_candidates, step_candidates, tip_candidates
      ▼
Stage 2 ──► one JSON recipe (chef decision)
      ▼
empty? ──retry stage 2──►
      ▼
validate ──fail? ──retry stage 2 + feedback──► best-effort
      ▼
applyIngredientPostProcess ──► persist
```

### Ingredient post-process (detail)

```text
core + optional from chef
      ▼
clean names + normalize units → canonical names → dedupe / merge qty
      ▼
OPENAI_API_KEY? ──yes──► semantic core vs optional (+ validate, retry once)
      │                    └── fail / no key ──► keep deduped split
      ▼
final ingredients → DB JSON (unchanged schema)
```

### Extension merge

```text
append sources/raw_texts → combinedText → synthesizeRecipeFromCombinedRaw
      ├─► success → post-process ingredients → full UPDATE + last_diff + versions
      └─► fail → history + needs_review (body unchanged)
```

### Recipe page (data flow)

```text
Server: load recipe row (includes last_diff, versions, ingredients, …)
      ▼
RecipeView: scale servings (memo) + display dedupe for lists
      ▼
No extra API calls on /recipe/[id]
```

---

## 13. Future-friendly

Auth / RLS, platform APIs, mobile share, grocery lists.

---

*Last updated: **ingredient post-process** (normalize, dedupe, optional semantic core/optional + validation); **recipe page** 720px layout, core/optional cards, knowledge tabs, source history, **Recently improved** + **`last_diff`**; diagrams and OpenAI call counts adjusted accordingly.*
