# Recipe Cloud — Flow & architecture documentation

This document describes how the app works end-to-end: **phased synthesis** + **dynamic playbook**, **extension merge review** (`pending_merge` → **`merge-decision`**), **`source_extractions`**, **material diffs**, and **recipe page** as the living workspace. Companion docs: **`RECIPE_WORKSPACE.md`**, **`MERGE_REVIEW_FLOW.md`**.

---

## 1. Product overview

**Recipe Cloud** is an **evolving recipe workspace**, not a one-shot extractor: you start a solid first version (web or extension), then **refine** by adding sources from the extension while the **recipe page** stays the home base to cook from. See **`docs/RECIPE_WORKSPACE.md`** for the full mental model (strong vs weak sources, web vs extension roles).

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
- **Consensus engine** (**`lib/ingredientConsensus.ts`**): before Phase C, clusters Phase A lines; **dish_anchors** included in consensus “lean CORE” hints.
- **Dish anchors** (**`lib/dishAnchors.ts`**): per-family + name-based slots (e.g. karaage → protein, coating_starch, frying_oil, marinade_base). **materializeAnchorsFromLines** picks concrete lines from Phase A; merged into Phase B essentials after playbook; **enforceAnchorsInCore** post–Phase C. **phasePreCIngredientRoleMap** maps lines → structure/protein/base/coating/cooking_medium/flavor/garnish.
- **Phase C**: **DISH_ANCHOR_OVERRIDE** (core overrules low confidence); validation retries for missing anchors, protein/oil stuck in optional, duplicates; artifact cleanup (**see blog**, note lines).
- **Role pass**: structure / flavor_base / richness / garnish / aroma / optional_enhancement — Phase D + optional **sort** for optional list on save (**`sortIngredientsByRole`**).
- **Step Flow Canonicalization** (**`lib/stepFlowCanonicalization.ts`**, pre–Phase D): action-phase clustering (marinate / fry / prep / assemble), scaffold stripping on lines, **`canonicalizeStepFlow`** → **`CanonicalizeResult`** (plan + metrics). Phase D **must not run** without **`canonical_step_plan`** (fatal log + abort). **`mergeRecipesIntelligent`** fallback uses the same canonicalization before structured steps; emergency minimal spine if LLM fails. Unified log: **`[synthesis-phased:canonical-flow]`** (`raw_step_candidates`, `cluster_count`, `dominant_flow_stage_count`, `secondary_flow_count`, `final_authored_step_count`, `path=phased|merge_intelligent_fallback`).
- **Phase D**: **strict** prompt — only ingredients, playbook block (expected_flow + failure points + roles), **dominant_flow**, canonical tip/warning/variant lines. No raw **`step_candidates`**, subs, or Phase A tips in the step prompt. Target **6–9** steps, max **12**; validation retry block lists concrete failures.
- **Finalize** (**`lib/recipeOutputCleanup.ts`**): structural step dedupe, collapse repeated fry/marinate/coats, strip blog scaffolding, cap steps at 12. **`mergeRecipesIntelligent`** fallback runs the same canonicalization before **`finalizeStructuredSteps`**.
- **`recipe_quality`**: **`dish_taxonomy`** (family id), **`cuisine`**, **synthesis_style**, **variant_notes**, **core_rationale**, **critical_tips**, **avoid_mistakes**, **`ingredient_roles`**, **`ingredient_signals`** (post–Phase C snapshots: name, **total_score**, bucket, anchor_match, frequency — for merge diffs). Create + extension pass **`synthesis_style`**.

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
| **Merge** | Re-synthesize with **all existing + new** text → store **`pending_merge`** only; return **`reviewRequired`** + proposal. User chooses via **`POST /api/recipes/[id]/merge-decision`**. |
| **Merge → Apply** | Commit proposed body + append **`sources`/`raw_texts`/`source_extractions`**; **`last_diff`** + **`versions`**. |
| **Merge → Keep source** | Append **`sources`/`raw_texts`/`source_extractions`** only; body unchanged; **`versions`** note. |
| **Merge → Discard** | Clear **`pending_merge`**; row unchanged. |
| **Merge synth fail** | Still **`pending_merge`** + review; **Apply** disabled; **Keep** / **Discard** available. |

See **`docs/MERGE_REVIEW_FLOW.md`**.

### Recipe diff (after user applies merge)

| Step | What runs |
|------|-----------|
| 1 | **`previousRecipe`** = committed row before apply. |
| 2 | **`nextRecipe`** = proposed payload (from **`pending_merge`**). |
| 3 | **`diffRecipes`** + **`materialRecipeDiffStructured`**. |
| 4 | **`computeMergeQualityScore`** (0–100 + reason) + **`computeIngredientScoreDiffNotes`** (prev vs next **`ingredient_signals`**) prepended to **key improvements** + **`last_diff.ingredient_score_notes`**. Then **`summarizeRecipeDiffWithAi`** (material-only bullets, **`is_better_signal`**) → **`last_diff.merge_quality_*`**, **`pending_merge.diff`**. |
| 5 | On **Apply**: write **`last_diff`**; prepend **`versions[]`**. |

**UI:** Extension **review** (apply / keep source / discard); recipe page **“What changed”** → **`RecipeUpdatedModal`** (“Recipe updated”); empty material diff → friendly **“little changed”** summary in preview + **`last_diff`**.

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
┌─────────────────────────┐   ┌──────────────────────────────────┐
│  OpenAI (gpt-4o-mini)   │   │  Supabase · recipes row          │
│  JSON completions       │   │  body · sources · raw_texts ·    │
│                         │   │  source_extractions · quality ·  │
│                         │   │  pending_merge (merge preview)   │
└─────────────────────────┘   └──────────────────────────────────┘
```

### 2.2 Synthesis pipeline (order of operations)

| Step | Module | What happens |
|------|--------|--------------|
| 1 | **`recipeSynthesisPhased`** | **Phase A:** per-source **`ingredient_candidates`**, **`step_candidates`**, **`tip_candidates`**. |
| 2 | same | **Phase B:** dish profile (canonical name, **cuisine**, essentials, optionals). |
| 3 | **`dynamicPlaybook.compileDynamicPlaybook`** | Chooses **dish family**, **`dish_anchors`** (mandatory core slots: protein, coating_starch, frying_oil, broth/noodles, dough/sauce/cheese, …), **expected_flow**, signature anchors, tools, timing, failure points. |
| 4 | same | **Phase C:** **ingredient importance scores** (`IngredientSignal`: frequency, confidence, role, dish-anchor match → weighted **total_score**; anchors floor ≥85; core ≥70 / optional 30–69 / ignore &lt;30). LLM **substitutions-only**; retries rebucket thresholds. **`recipe_quality.ingredient_signals`**. Merge diffs: **`ingredient_score_notes`** + key improvements. **`playbookForPhaseC`**. |
| 5 | same | **Ingredient roles** → **Step Flow Canonicalization** → Phase D. |
| 6 | same | **Phase D:** canonical plan as hard input + **`playbookForPhaseD`**; band **6–9** (max 12); validation + retry. |

**Public entry:** **`recipeSynthesis.ts`** (`synthesizeRecipeFromCombinedRaw*`, `synthesizeRecipeFromVersions`) — all delegate to **`synthesizeRecipePhased`**.

**Fallback:** empty corpus → **`mergeRecipesIntelligent`** → same phased pipeline on structured **`ExtractedRecipe`** blobs (**`synthesizeRecipeFromVersions`**).

### 2.3 Key files (quick map)

| Area | Files |
|------|--------|
| Phased synthesis | **`lib/recipeSynthesisPhased.ts`** |
| Dynamic playbook | **`lib/dynamicPlaybook.ts`** (primitives, **`FAMILY_SKELETONS`**, **`CUISINE_LENSES`**) |
| Facade + chunks | **`lib/recipeSynthesis.ts`** |
| Merge / DB shape | **`lib/aiMerge.ts`**, **`lib/types.ts`** (`RecipeQualityMeta`, **`dish_taxonomy`** = stored **dish family** id) |
| Ingredient scoring | **`lib/ingredientSignalScoring.ts`** (`IngredientSignal`, rebucket retries, merge diff notes) |
| Merge quality | **`lib/mergeQualityScore.ts`** |
| Anchors / consensus / cleanup | **`lib/dishAnchors.ts`**, **`lib/ingredientConsensus.ts`**, **`lib/recipeOutputCleanup.ts`** |
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
| Diff | **`recipeDiff.ts`** (incl. **`materialRecipeDiffStructured`**), **`recipeDiffAi.ts`** |
| Merge fallback | **`aiMerge.ts`**, **`structuredSteps.ts`** |
| Ingest | **`sourcePipeline.ts`**, **`websiteExtract.ts`**, **`aiExtractor.ts`** |
| UI | **`RecipeView.tsx`**, **`RecipeUpdatedModal.tsx`** |
| AI | OpenAI **`gpt-4o-mini`** |
| Extension | Chrome MV3 |

**Scripts:** **`npm run test:merge`** — **`scripts/merge-review-check.ts`** (pending-merge shape sanity); **`scripts/chef-synthesis-scenarios.ts`** (synthesis scenario harness).

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
| **Hero** | Title, **summary**, short **workspace** line; metadata (time, servings, **source count**). |
| **Alerts** | **`needs_review`**, empty-state CTA, **What changed** → **`RecipeUpdatedModal`**. |
| **Servings** | − / + ; **core + optional** scaled the same (**`scaleIngredients`**). |
| **Core** | Dish-defining ingredients (deduped); **“Why essential?”** when **`core_rationale`** present. |
| **Optional & customize** | Enhancements / garnishes / style. |
| **Substitutions** | Shown only if **options or note** exist (meaningful swaps). |
| **Start cooking** | Scroll to **`#recipe-steps`**. |
| **Steps** | Number, title, time/tools, instructions, **`warnings`**. |
| **Tips** | Flat list if non-empty. |
| **Quality** | Family pill (**`dish_taxonomy`**), **`cuisine`** pill, style; **Must know** / **Avoid** (microcopy); **Variants**; **“Why these essentials”** disclosure for **`core_rationale`**. |
| **History** | **History — *N* sources** + **`versions[]`** + source URLs. |

**Data freshness:** **`unstable_noStore()`** in recipe loader so merges from the extension show the latest row. Extension opens **`/recipe/{id}?updated=…&cb=…`** to avoid stale tab cache.

**No extra client API calls** for scaling.

### 4.4 Extension

**Add to which recipe?** (current / recent / new) → **`POST /api/extract-from-extension`**. **Merge** returns **`reviewRequired`** → **Apply** / **Keep source only** / **Discard** via **`POST /api/recipes/[id]/merge-decision`**. ~5k DOM chars. **View recipe** uses **`?updated=&cb=`** cache-bust.

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
| **C** | **Score-based core / optional** (**`buildIngredientSignals`** from Phase A lines + roles + anchors; weighted **total_score**; anchor-matched lines floor ≥85; buckets core ≥70 / optional 30–69 / ignore &lt;30). **`phaseCSubstitutionsOnly`** LLM → substitutions + **`core_rationale`** / variants only. Validation retries (**rebucket** lower core threshold; last resort full **`phaseCIngredients`**). |
| **Roles** | Per-ingredient roles for Phase D. |
| **Canonical flow** | **`canonicalizeStepFlow`**: one **dominant_flow**; demote alternates to tips/warnings/variants. |
| **D** | **Steps** from canonical plan + ingredients only (6–9 target, max 12). Retry on multi-flow / dupes / section titles. Family step injection when needed. |

**Saved shape:** **`description`** = summary; **`mistakes`/`techniques`** → **`[]`** on new synth; substitutions **`{ ingredient, options, note? }`**; **`recipe_quality.dish_taxonomy`** = **dish family** id (e.g. `noodle_soup`).

**OpenAI calls (typical):** **Phase A, B, playbook compile, C, roles, D** — often **6+** JSON completions per run; retries add more.

### 7.2 Fallback: `mergeRecipesIntelligent`

When corpus phased synthesis is **null** or yields an empty body: build chunks from **`ExtractedRecipeWithConfidence[]`**, run the **same 4-phase** via **`synthesizeRecipeFromVersions`**.

### 7.3 `mergedOutputToDbRow` / `synthesisPayloadToMerged`

Map **`SynthesisDbPayload`** → DB columns (**`aiMerge.ts`**).

---

## 8. Extension merge (sequence) — review before commit

1. Load recipe; compute **would-be** **`next_sources` / `next_raw_texts`** (not written yet).
2. **`synthesizeRecipeFromCombinedRawWithExtractions`** on full corpus (existing + new chunk).
3. **`diffRecipes`** (committed vs proposed) → **`materialRecipeDiffStructured`** → **`computeMergeQualityScore`** + ingredient score notes → **`summarizeRecipeDiffWithAi`** (or heuristic). If no material bullets, summary explains **subtle / unchanged headline recipe**.
4. **`UPDATE recipes SET pending_merge = …`** only (shape **`lib/mergePending.ts`**). Response: **`reviewRequired: true`**, **`proposal`**, **`synthOk`**.
5. **`POST /api/recipes/[id]/merge-decision`**:
   - **`apply`** — write body + history + **`last_diff`** + **`versions`**; clear **`pending_merge`**.
   - **`keep_source`** — append **`sources`/`raw_texts`/`source_extractions`** only; body unchanged; **`versions`** note; clear **`pending_merge`**.
   - **`discard`** — clear **`pending_merge`**; no history append.

Synth failure still sets **`pending_merge`**; **Apply** disabled in extension; **keep** / **discard** work.

**New recipe** from extension: unchanged — immediate insert (no **`pending_merge`**).

---

## 9. API routes (summary)

| Route | Purpose |
|-------|---------|
| `GET /api/recipes?limit=5` | Extension picker |
| `DELETE /api/recipes/[id]` | Delete |
| `POST /api/recipes/create` | Multi-source create |
| `POST /api/extract-from-extension` | New recipe **or** merge **preview** (`reviewRequired`) |
| `POST /api/recipes/[id]/merge-decision` | **`apply`** \| **`keep_source`** \| **`discard`** (after merge preview) |
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
| **`last_diff`**, **`versions`**, **`pending_merge`** | Merge UX + optional pending proposal |

Migrations: **`create_recipes`** → … → **`recipe_last_diff`**; **`source_extractions`** (**`20250325000000_source_extractions.sql`**); **`recipe_quality`** (**`20250326000000_recipe_quality.sql`**); **`pending_merge`** (**`20250327000000_pending_merge.sql`**).

---

## 11. Environment

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, **`OPENAI_API_KEY`**.

---

## 12. Log prefixes

`[extract]`, `[pipeline]`, `[OpenAI]`, **`[synthesis-phased:B]`**, **`[synthesis-phased:playbook]`**, **`[synthesis-phased:C]`**, **`[synthesis-phased:roles]`**, **`[synthesis-phased:canonical-flow]`**, **`[synthesis-phased:D]`**, **`[dynamic-playbook]`**, **`[recipeDiffAi]`**, **`[extract-from-extension]`**, **`[merge-decision]`**, `[merge]`.

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
Phase C ──► signals → core/optional; LLM subs only; enforce anchors; dedupe / retry
      ▼
Roles ──► per-ingredient roles for authoring
      ▼
Canonical flow ──► cluster step_candidates → ONE dominant_flow (+ demoted tips/variants)
      ▼
Phase D ──► steps from canonical plan only (+ validation retry)
      ▼
summary + tips + critical/avoid
      ▼
SynthesisDbPayload → DB
```

### Extension merge (review gate)

```text
existing row + new capture (in memory only)
      ▼
synthesizeRecipeFromCombinedRawWithExtractions (full corpus)
      ▼
diff + AI summary → pending_merge on row (no body commit yet)
      ▼
Extension: Apply | Keep source | Discard
      ▼
merge-decision
      ├─ apply   → body + sources + extractions + last_diff + versions
      ├─ keep_source → sources + extractions only + versions note
      └─ discard → pending_merge cleared
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

## 14. Ingredient importance scoring (reference)

**Module:** **`lib/ingredientSignalScoring.ts`**.

Each clustered ingredient becomes an **`IngredientSignal`**: **frequency** (distinct sources), **confidence_levels** (per-source `high` / `medium_high` / `medium` / `low`), **role** (from **`phasePreCIngredientRoleMap`**: protein, structure, base, coating, cooking_medium, flavor, garnish, …), **anchor_match** (satisfies a **materialized** dish anchor or token match).

| Component | Rule |
|-----------|------|
| **frequency_score** | `min(100, frequency × 30)` |
| **confidence_score** | max across sources: high 100, medium_high 80, medium 60, low 30 |
| **role_score** | protein/structure 100; base/coating 85; cooking_medium 80; flavor 50; garnish 20 |
| **anchor_score** | 100 if anchor match else 0 |
| **total_score** | `0.3×freq + 0.2×conf + 0.25×role + 0.25×anchor` |
| **Anchor override** | If **anchor_match**, **total_score** forced to **≥ 85** |
| **Buckets** | core ≥70 · optional [30,70) · ignore &lt;30 |

**Phase C loop:** classify → **`enforceAnchorsInCore`** → normalize/dedupe → validation (**anchors in core**, no protein in optional, no dupes, no required structure in optional only). On failure, **rebucket** with a lower core threshold; on repeated failure, fallback to full Phase C LLM for ingredients.

**Merge:** **`computeIngredientScoreDiffNotes`** compares stored **`ingredient_signals`** before/after (e.g. “X importance increased”, “Y added as optional”) for **`key_improvements`** and **`last_diff.ingredient_score_notes`**.

---

## 15. Future-friendly

Auth / RLS, platform APIs, mobile share, grocery lists.

---

*Last updated: **ingredient importance scoring** (§14, Phase C signals + **`ingredient_signals`**); **merge quality** + **`ingredient_score_notes`**; **dish anchors** + consensus; **merge review** (`pending_merge`, **`merge-decision`**); **Phase D** structured steps; **`RECIPE_WORKSPACE.md`** / **`MERGE_REVIEW_FLOW.md`**.*
