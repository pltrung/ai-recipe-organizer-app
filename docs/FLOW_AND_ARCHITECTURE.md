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

### Chef-quality layer (synthesis)

- **Dish family** (dynamic playbook, after Phase B): **`lib/dynamicPlaybook.ts`** composes **`dish_family`** + flow from **universal primitives**, **family skeletons** (e.g. `noodle_soup`, `pizza_flatbread`, `braise_stew`), **cuisine lens**, and **anchors** from Phase A candidates + confidence. Stored in **`recipe_quality.dish_taxonomy`** as the family id (UI label). Phase C/D prompts include **`playbookForPhaseC` / `playbookForPhaseD`**.
- **Source confidence** per chunk: `high` / `medium_high` / `medium` / `low` (blog/JSON-LD vs reel/DOM). Low-confidence-only lines must not become **core** unless dish-essential or corroborated.
- **Phase C**: cook **style** (`authentic` | `easier_at_home` | `lighter` | `rich_indulgent`), **core rationale**, **variant_notes** (1–3 if sources diverge).
- **Role pass**: structure / flavor_base / richness / garnish / aroma / optional_enhancement — informs Phase D.
- **Phase D**: playbook-ordered steps; **critical_tips** + **avoid_mistakes**; validation retry so **every core** appears in some step.
- **`recipe_quality`** JSON on row: taxonomy, style, variants, rationale, roles, critical/avoid. **`POST /api/recipes/create`** accepts **`synthesis_style`**; extension accepts **`synthesis_style`**.

### Synthesis entrypoints (`recipeSynthesis.ts`)

| Function | Use |
|----------|-----|
| **`synthesizeRecipeFromCombinedRaw`** | Returns final **`SynthesisDbPayload`** only. |
| **`synthesizeRecipeFromCombinedRawWithExtractions`** | Returns **`payload`** + **`source_extractions`** for DB (create + extension merge). |
| **`synthesizeRecipeFromVersions`** | Same 4-phase pipeline on **synthetic chunks** from structured **`ExtractedRecipe`** rows (**`mergeRecipesIntelligent`** fallback). |

Full re-synthesis uses **all** **`raw_texts[]`** (not incremental). Pipeline: **§7.1**. On successful corpus save, **`source_extractions`** is written; on structured-merge fallback after an empty corpus result, it may be **cleared** (`null`).

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

## 2. Architecture overview

### 2.1 Layers

```text
┌─────────────────────────────────────────────────────────────────┐
│  Web (/create, /recipe, /dashboard)  ·  Chrome extension (MV3)   │
└────────────────────────────┬────────────────────────────────────┘
                             │ POST create / extract-from-extension
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Next.js API routes  →  ingest pipeline  →  SourceChunk[]       │
│  (labels + raw_texts + per-chunk confidence)                     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  recipeSynthesis.ts  →  synthesizeRecipePhased                     │
│  (recipeSynthesisPhased.ts)                                        │
│    Phase A → B → Dynamic playbook → Phase C → ingredient roles   │
│    → Phase D → SynthesisDbPayload                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
┌─────────────────────────┐   ┌─────────────────────────────────┐
│  OpenAI (gpt-4o-mini)   │   │  Supabase: recipes row             │
│  JSON completions       │   │  body + sources + raw_texts +    │
│                         │   │  source_extractions + recipe_quality│
└─────────────────────────┘   └─────────────────────────────────┘
```

### 2.2 Synthesis pipeline (order of operations)

| Step | Module | What happens |
|------|--------|--------------|
| 1 | **`recipeSynthesisPhased`** | **Phase A:** per-source **`ingredient_candidates`**, **`step_candidates`**, **`tip_candidates`**. |
| 2 | same | **Phase B:** dish profile (canonical name, **cuisine**, essentials, optionals). |
| 3 | **`dynamicPlaybook.compileDynamicPlaybook`** | Chooses **dish family**, composes **expected_flow**, **anchors** (signature ingredients/techniques), tools, timing, failure points, serving — from **primitives + family skeleton + cuisine lens + Phase A signal**. |
| 4 | same | **Phase C:** core / optional / substitutions; prompt includes **`playbookForPhaseC`**. Retries for essentials / dedupe. |
| 5 | same | **Ingredient roles** pass → Phase D. |
| 6 | same | **Phase D:** steps + summary + tips; prompt includes **`playbookForPhaseD`**; step count band from family **min/max** (clamped). Validation retry. |

**Public entry:** **`recipeSynthesis.ts`** (`synthesizeRecipeFromCombinedRaw*`, `synthesizeRecipeFromVersions`) — all delegate to **`synthesizeRecipePhased`**.

**Fallback:** empty corpus → **`mergeRecipesIntelligent`** → same phased pipeline on structured **`ExtractedRecipe`** blobs (**`synthesizeRecipeFromVersions`**).

### 2.3 Key files (quick map)

| Area | Files |
|------|--------|
| Phased synthesis | **`lib/recipeSynthesisPhased.ts`** |
| Dynamic playbook | **`lib/dynamicPlaybook.ts`** (primitives, **`FAMILY_SKELETONS`**, **`CUISINE_LENSES`**) |
| Facade + chunks | **`lib/recipeSynthesis.ts`** |
| Merge / DB shape | **`lib/aiMerge.ts`**, **`lib/types.ts`** (`RecipeQualityMeta`, **`dish_taxonomy`** = stored **dish family** id) |
| Confidence | **`lib/sourceSynthesisConfidence.ts`** |
| Ingest | **`lib/sourcePipeline.ts`**, **`websiteExtract.ts`**, **`aiExtractor.ts`** |

---

## 3. Tech stack (reference)

| Layer | Technology |
|-------|------------|
| Web | Next.js 14 (App Router), TypeScript, Tailwind |
| DB | Supabase (Postgres) |
| Synthesis | **`recipeSynthesisPhased.ts`**, **`dynamicPlaybook.ts`**, **`recipeSynthesis.ts`** |
| Ingredients | **`ingredientNormalize.ts`** (Phase C dedupe) |
| History | **`recipeSourceHistory.ts`** |
| Diff | **`recipeDiff.ts`**, **`recipeDiffAi.ts`** |
| Merge fallback | **`aiMerge.ts`**, **`structuredSteps.ts`** |
| Ingest | **`sourcePipeline.ts`**, **`websiteExtract.ts`**, **`aiExtractor.ts`** |
| UI | **`RecipeView.tsx`**, **`RecipeUpdatedModal.tsx`** |
| AI | OpenAI **`gpt-4o-mini`** |
| Extension | Chrome MV3 |

---

## 4. User-facing entry points

### 4.1 Create (`/create`)

**`POST /api/recipes/create`** — multi-source ingest → phased corpus save → draft or **`mergeRecipesIntelligent`** fallback.

### 4.2 Dashboard (`/dashboard`)

List by **`updated_at`**; **`DELETE /api/recipes/[id]`**.

### 4.3 Recipe (`/recipe/[id]`)

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
| **Tips** | Flat list if non-empty. |
| **Quality** | **`recipe_quality`**: dish-family pill (**`dish_taxonomy`** = family id), optional **synthesis style**, **Must know** / **Avoid**, **Variants**; per-ingredient **core rationale** (“why core”) where present. **`ingredient_roles`** stored for Phase D / future UI. |
| **History** | “Updated from *N* sources” + **`versions[]`**; collapsible source URLs. |

**Data freshness:** **`unstable_noStore()`** in recipe loader so merges from the extension show the latest row. Extension opens **`/recipe/{id}?updated=…&cb=…`** to avoid stale tab cache.

**No extra client API calls** for scaling.

### 4.4 Extension

Picker → **Add this page** → **`POST /api/extract-from-extension`**. ~5k DOM chars. **View recipe** uses cache-bust query params.

---

## 5. Link classification (`classifyLink`)

YouTube → `youtube`; TikTok / IG / FB / XHS → `reel_fallback`; else **`html_parse`**.

---

## 6. Per-source extraction (ingest, not synthesis Phase A)

**`ExtractedRecipe`**, **`StructuredIngredient`**. Blogs: JSON-LD **`Recipe`** may skip OpenAI. See **`websiteExtract.ts`**, **`sourcePipeline.ts`**, **`aiExtractor.ts`**.

**Synthesis Phase A** (different): model reads each **`raw_texts[i]`** block and emits **candidate lists** only — stored in **`source_extractions[i]`** when synthesis succeeds.

---

## 7. Corpus synthesis & fallbacks

### 7.1 Pipeline phases (`recipeSynthesisPhased.ts` + `dynamicPlaybook.ts`)

| Stage | Output |
|-------|--------|
| **A** | Per source: **`ingredient_candidates`**, **`step_candidates`**, **`tip_candidates`** (no final recipe). |
| **B** | **Dish profile:** canonical name, **cuisine**, **essentials**, acceptable optionals. |
| **Dynamic playbook** | **`dish_family`**, **`expected_flow`**, **anchors**, **likely_tools**, **timing_expectations**, **failure_points**, **serving_style** — steers C and D. |
| **C** | **Core / optional / substitutions**; playbook text in prompt; retries if essentials missing or misplaced. |
| **Roles** | Per-ingredient roles for Phase D. |
| **D** | **Steps** (count within family band), **`summary`**, **`tips`**, **`critical_tips`**, **`avoid_mistakes`**, **`servings`**, step **`warnings`**. Retry if cores missing from steps or validation fails. |

**Saved shape:** **`description`** = summary; **`mistakes`/`techniques`** → **`[]`** on new synth; substitutions **`{ ingredient, options, note? }`**; **`recipe_quality.dish_taxonomy`** = **dish family** id (e.g. `noodle_soup`).

**OpenAI calls (typical):** **Phase A, B, playbook compile, C, roles, D** — often **6+** JSON completions per run; retries add more.

### 7.2 Fallback: `mergeRecipesIntelligent`

When corpus phased synthesis is **null** or yields an empty body: build chunks from **`ExtractedRecipeWithConfidence[]`**, run the **same 4-phase** via **`synthesizeRecipeFromVersions`**.

### 7.3 `mergedOutputToDbRow` / `synthesisPayloadToMerged`

Map **`SynthesisDbPayload`** → DB columns (**`aiMerge.ts`**).

---

## 8. Extension merge (sequence)

1. **`mergeSources`** → **`source_urls`**, **`source_platforms`**.
2. Append **`sources`**, **`raw_texts`**.
3. **`synthesizeRecipeFromCombinedRawWithExtractions`**.
4. **Success:** full UPDATE (body + **`source_extractions`**) + **`last_diff`** + **`versions`**, **`needs_review: false`**.
5. **Failure:** history-only UPDATE, **`needs_review: true`**, body unchanged.

---

## 9. API routes (summary)

| Route | Purpose |
|-------|---------|
| `GET /api/recipes?limit=5` | Extension picker |
| `DELETE /api/recipes/[id]` | Delete |
| `POST /api/recipes/create` | Multi-source create |
| `POST /api/extract-from-extension` | Create / merge |
| `POST /api/extract` | Debug |
| `POST /api/merge` | JSON merge |

---

## 10. Database (`recipes`)

| Column | Role |
|--------|------|
| **`ingredients`**, **`steps`**, **`tips`**, **`substitutions`**, **`servings`**, **`servings_base`**, **`description`**, **`estimated_time`** | Main body |
| **`mistakes`**, **`techniques`** | Legacy columns; **empty arrays** on new synthesis |
| **`source_urls`**, **`source_platforms`**, **`raw_text`**, **`sources`**, **`raw_texts`**, **`source_extractions`** | Provenance + Phase A snapshot |
| **`needs_user_input`**, **`needs_review`** | Draft / failed re-synth |
| **`last_diff`**, **`versions`** | Merge UX + history |

Migrations: chain from **`create_recipes`** through **`recipe_last_diff`**; add **`source_extractions`** via **`20250325000000_source_extractions.sql`**.

---

## 11. Environment

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, **`OPENAI_API_KEY`**.

---

## 12. Log prefixes

`[extract]`, `[pipeline]`, `[OpenAI]`, **`[synthesis-phased]`**, **`[dynamic-playbook]`** (family, lens, anchors, playbook summary; fallback on AI failure), **`[recipeDiffAi]`**, **`[extract-from-extension]`**, `[merge]`.

---

## 13. Diagrams

### Web create

```text
ingest (parallel)
      → historySources[] + historyRawTexts[]
      → synthesizeRecipeFromCombinedRawWithExtractions
            A → B → dynamic playbook → C → roles → D
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
Dynamic playbook ──► family + expected_flow + anchors (from A candidates + confidence)
      ▼
Phase C ──► core, optional, substitutions (+ playbook context; dedupe / retries)
      ▼
Roles ──► per-ingredient roles for authoring
      ▼
Phase D ──► steps + summary + tips + critical/avoid (+ step validation retry)
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

## 14. Future-friendly

Auth / RLS, platform APIs, mobile share, grocery lists.

---

*Last updated: **§2 architecture** (layers + synthesis pipeline table); **A → B → dynamic playbook → C → roles → D**; **`dynamicPlaybook.ts`**; **`recipe_quality`** / dish-family UI; **`[dynamic-playbook]`** logs; create diagram and phase table aligned.*
