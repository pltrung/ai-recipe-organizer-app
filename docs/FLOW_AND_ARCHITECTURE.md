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
- **Consensus engine** (**`lib/ingredientConsensus.ts`**): clusters Phase A lines for **LLM context** (Phase C substitution pass + full-ingredient fallback); **dish_anchors** in “lean CORE” hints. Scoring does **not** use consensus clusters — it uses **canonical entities** below.
- **Ingredient canonicalization** (**`lib/ingredientCanonicalization.ts`**): after consensus formatting, **every Phase A line** is collapsed to **`CanonicalIngredientEntity`** (`canonical_name`, `variants[]` with line + source + confidence, **`ingredient_type`** heuristic). Cluster key = **`normalizeIngredientName`** on parsed name, else stem/cleaning key. **Single dedupe point** for ingredient identity. Log **`[ingredient-canonicalization] raw_count=… canonical_count=… clusters_formed=…`**.
- **Dish anchors** (**`lib/dishAnchors.ts`**): per-family + name-based slots. **materializeAnchorsFromLines** maps abstract anchors to concrete Phase A lines; merged into **profile.essential_ingredients**. **Anchor scoring** uses **`canonical_name` only** (token match + **materializedMatchesCanonicalName**). **enforceAnchorsInCore** moves materialized anchor lines into core when missing. **phasePreCIngredientRoleMap** maps **raw lines** → roles (variants inherit best role for scoring).
- **Phase C (signal path)**: **buildIngredientSignalsFromCanonical** → buckets; **postCanonicalIngredientCleanup** (**uniqueCoreByCanonicalName**, **stripOptionalOverlappingCore**, **cleanupIngredientArtifacts**). Retries: **rebucketSignals** (lower core threshold 70 → 65 → 58 → 52); last attempt **phaseCIngredients** LLM. Then **phaseCSubstitutionsOnly** for subs + core_rationale. Full-ingredient fallback prompt still uses **numbered** lines + consensus (not re-canonicalizing output).
- **Role pass**: structure / flavor_base / richness / garnish / aroma / optional_enhancement — Phase D + optional **sort** for optional list on save (**`sortIngredientsByRole`**).
- **Step Flow Canonicalization** (**`lib/stepFlowCanonicalization.ts`**, pre–Phase D): **`actionPhaseBucket`** (marinate / fry / prep / assemble / other); **`stripSourceScaffoldingLine`** on candidates; Jaccard clustering (tighter merge within the same phase). **`canonicalizeStepFlow`** → **`CanonicalizeResult`** (`plan`, `rawCandidateCount`, `clusterCount`, `secondaryFlowItemCount`, `usedLlmPlan`). **`ensureCanonicalPlanHasStages`** guarantees **≥3 stages** (playbook **`expected_flow`** or safe defaults) so Phase D always has a spine. Secondary methods → **`tip_candidates` / `warning_candidates` / `variant_candidates`** + **`discarded_or_secondary_flows`**. **`mergeRecipesIntelligent`** (chef + structured path): same **`canonicalizeStepFlow`** → **`finalizeStructuredSteps`** with **`canonicalSpine`**; if spine missing, **emergency 3-stage** spine + error log (never “raw steps only”). Unified log **`[synthesis-phased:canonical-flow]`**: `raw_step_candidates`, `cluster_count`, `dominant_flow_stage_count`, `secondary_flow_count`, `final_authored_step_count`, `canon_source`, `path=phased` \| `merge_intelligent_fallback`.
- **Phase D**: **strict** prompt — finalized ingredients, single **playbook block** (playbook + **expected_flow** + failure points + roles), **CANONICAL_STEP_PLAN** only; no raw **`step_candidates`**, subs, or Phase A tips in the step prompt. Target **6–9** steps, max **12**; validation retries with explicit failure list. **Emergency steps:** if the Phase D LLM returns no usable steps after retries, build **`RecipeStep[]`** from **dominant_flow** stages (or a 3-step generic fallback) so **create/merge** can still succeed.
- **Phase C recovery:** if **core** is empty after scoring but **optional** has **≥3** lines, promote top optional lines to **core** (logged), then continue.
- **Finalize** (**`lib/recipeOutputCleanup.ts`** **`finalizeSynthesisPayload`**): **no ingredient list dedupe** (identity fixed at canonicalization). Optional list: **sortIngredientsByRole** when roles exist, **trimOptionalList** cap. **filterSubsQuality** on substitutions. Steps: **dedupeRecipeSteps**, **collapseRepeatedActionSteps**, **stripStepScaffolding**, dedupe again, trim warnings, cap **12**. Tips deduped/capped.
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
| **Merge synth fail** (`synthOk: false`) | Still **`pending_merge`**; **Apply** disabled; user sees “couldn’t merge” copy. **Keep** / **Discard** still work. Causes: synthesis **null** (e.g. no API key, empty corpus) or payload with **no core + no steps**. Resilience (canonical spine, emergency steps, optional→core) reduces false failures on real recipe pages. |

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
│  recipeSynthesis.ts  →  synthesizeRecipePhased                       │
│  (recipeSynthesisPhased.ts)                                        │
│    A→B→playbook→consensus→canonicalize→roleMap→C→roles→canon flow→D→finalize │
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

| # | Module | What happens |
|---|--------|--------------|
| 1 | **`phaseAExtract`** | Per chunk: **`ingredient_candidates`**, **`step_candidates`**, **`tip_candidates`**. Empty ingredients → one repair JSON pass. |
| 2 | **`phaseBDishProfile`** | **`canonical_dish_name`**, **`cuisine_style`**, **`essential_ingredients`**, **`optional_acceptable`** (+ name-inferred anchors). |
| 3 | **`compileDynamicPlaybook`** | **dish_family**, **dish_anchors**, **expected_flow**, **signature_ingredients**, tools, timing, **failure_points**, **stepMin/stepMax** band. **`playbookForPhaseC` / `playbookForPhaseD`**. |
| 4 | **`materializeAnchorsFromLines`** | Concrete lines from Phase A per anchor slot; **mergeEssentialLists** into profile essentials + signatures. |
| 5 | **Numbered lines** | Flatten Phase A ingredients with **sourceIndex** + **sourceConf** (chunk confidence). |
| 6 | **`buildIngredientConsensus`** + **`formatConsensusForPhaseC`** | Clusters + text block for later LLM calls (not the scoring input). |
| 7 | **`canonicalizeIngredients`** | One entity per concept → Phase C scoring input. |
| 8 | **`phasePreCIngredientRoleMap`** | LLM: each **raw candidate line** → role (protein, structure, base, coating, cooking_medium, flavor, garnish, …). |
| 9 | **Phase C loop** (≤4 tries) | **buildIngredientSignalsFromCanonical** (attempt 0) or **rebucketSignals** (attempts 1+). **signalsToStructuredGroups** → **enforceAnchorsInCore** → **postCanonicalIngredientCleanup**. Empty core → lower **coreScoreMin** and retry. **phaseCFixReason** (essentials, anchor coverage, essentials in optional, protein/oil rules, duplicate core, core/optional overlap; attempt 0 skips “low-source-only in core” demotion) → if fail: lower threshold; on 4th fail → **phaseCIngredients** full LLM. On pass → **phaseCSubstitutionsOnly** (subs, **core_rationale**, **variant_notes**). |
| 10 | **Post–C hardening** | If core empty and optional ≥3 → promote first optional lines to core. Again **enforceAnchorsInCore** + **postCanonicalIngredientCleanup**. Log essentials OK/missing. |
| 11 | **`mergedStepBand`** | Target step count from core size + playbook. |
| 12 | **`phaseIngredientRoles`** | Tags **final** core+optional names for Phase D block (**INGREDIENT_ROLES**). |
| 13 | **`canonicalizeStepFlow`** + **`ensureCanonicalPlanHasStages`** | Step candidates → **dominant_flow** + tips/warnings/variants; ≥3 stages. |
| 14 | **`phaseDAuthoring`** (≤4 tries) | Steps only from **CANONICAL_STEP_PLAN** + playbook; **injectFamilyMandatorySteps**; **collectStepValidationIssues** (core/optional mention, band, expected_flow). Emergency steps from canonical stages if LLM empty. |
| 15 | **`finalizeSynthesisPayload`** | Steps polished; ingredients passed through (optional sort/trim); **`signalsToSnapshots`** → **`recipe_quality.ingredient_signals`**. |

**Public entry:** **`recipeSynthesis.ts`** — **`synthesizeRecipePhased`**.

**Fallback:** empty corpus → **`mergeRecipesIntelligent`** → **`synthesizeRecipeFromVersions`** or chef + **canonicalizeStepFlow** path (**`structuredSteps.ts`**).

### 2.3 Key files (quick map)

| Area | Files |
|------|--------|
| Phased synthesis | **`lib/recipeSynthesisPhased.ts`** |
| Dynamic playbook | **`lib/dynamicPlaybook.ts`** (primitives, **`FAMILY_SKELETONS`**, **`CUISINE_LENSES`**) |
| Facade + chunks | **`lib/recipeSynthesis.ts`** |
| Merge / DB shape | **`lib/aiMerge.ts`**, **`lib/types.ts`** (`RecipeQualityMeta`, **`dish_taxonomy`** = stored **dish family** id) |
| Ingredient canonicalization | **`lib/ingredientCanonicalization.ts`** (`CanonicalIngredientEntity`, cluster keys) |
| Ingredient scoring | **`lib/ingredientSignalScoring.ts`** (`buildIngredientSignalsFromCanonical`, **rebucketSignals**, **signalsToStructuredGroups**, **signalsToSnapshots**) |
| Merge quality | **`lib/mergeQualityScore.ts`** |
| Anchors / consensus / finalize | **`lib/dishAnchors.ts`**, **`lib/ingredientConsensus.ts`**, **`lib/recipeOutputCleanup.ts`** |
| Step flow (canonical) | **`lib/stepFlowCanonicalization.ts`**, **`lib/structuredSteps.ts`** (merge fallback + spine) |
| Step quality (tests/asserts) | **`lib/stepRecipeQuality.ts`**, **`scripts/chef-synthesis-scenarios.ts`** |
| Confidence | **`lib/sourceSynthesisConfidence.ts`** |
| Ingest | **`lib/sourcePipeline.ts`**, **`websiteExtract.ts`**, **`aiExtractor.ts`** |

---

## 3. Tech stack (reference)

| Layer | Technology |
|-------|------------|
| Web | Next.js 14 (App Router), TypeScript, Tailwind |
| DB | Supabase (Postgres) |
| Synthesis | **`recipeSynthesisPhased.ts`**, **`dynamicPlaybook.ts`**, **`recipeSynthesis.ts`** |
| Ingredients | **`ingredientNormalize.ts`** (names/units), **`ingredientCanonicalization.ts`** (identity), **`ingredientParser.ts`** |
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

| Stage | Output / behavior |
|-------|-------------------|
| **A** | Per source: **`ingredient_candidates`**, **`step_candidates`**, **`tip_candidates`**. Retry if all sources empty ingredients. |
| **B** | **`DishProfile`**: name, cuisine, essentials, optionals. |
| **Playbook** | **`compileDynamicPlaybook`**: family, **dish_anchors**, **expected_flow**, signatures, step band, failure points. Essentials += **materializedAnchors** + signatures. |
| **Consensus** | **`buildIngredientConsensus`** rows + **`formatConsensusForPhaseC`** string → fed to **phaseCSubstitutionsOnly** / **phaseCIngredients** only. |
| **Canonicalize** | **`canonicalizeIngredients(numbered)`** → entities; log **`[ingredient-canonicalization]`**. |
| **Pre-C roles** | **`phasePreCIngredientRoleMap`**: raw line → role (drives **role_score** per variant). |
| **C (signals)** | **`buildIngredientSignalsFromCanonical`**: frequency = distinct sources in **variants**; confidence = max per source; **anchor_match** on **canonical_name** vs anchor tokens + materialized lines; **total_score**; anchor_match ⇒ score ≥85. Buckets: core ≥**coreScoreMin** (70, then 65/58/52 on retry), optional [30,70), ignore &lt;30. |
| **C (cleanup)** | **enforceAnchorsInCore** → **postCanonicalIngredientCleanup** (one core row per normalized name; drop optional rows whose name matches core; **cleanupIngredientArtifacts**). |
| **C (LLM)** | **phaseCSubstitutionsOnly** on success path. **phaseCIngredients** on 4th failed validation (full judge on **numbered** + consensus). |
| **Post-C** | Optional→core promotion if core empty. Second enforce + cleanup. |
| **Roles (D)** | **`phaseIngredientRoles`**: final ingredient names → roles for **playbookBlock**. |
| **Canonical flow** | **`canonicalizeStepFlow`** + **`ensureCanonicalPlanHasStages`** (≥3 stages). |
| **D** | **`phaseDAuthoring`**: **canonicalStepPlanBlock** + playbook; **injectFamilyMandatorySteps**; validation retries; emergency steps. |
| **Assemble** | Title, summary, time, tips, quality meta; **`ingredient_signals`** = **signalsToSnapshots(phaseC.signals)**. |
| **Finalize** | **`finalizeSynthesisPayload`**: optional sort/trim/subs filter; step **polish** (no ingredient dedupe). |

**Saved shape:** **`description`** = summary; **`mistakes`/`techniques`** → **`[]`** on new synth; substitutions **`{ ingredient, options, note? }`**; **`recipe_quality.dish_taxonomy`** = **dish family** id; **`ingredient_signals`** = post–C snapshots for merge diffs.

**OpenAI calls (typical):** A, B, playbook, **phasePreCIngredientRoleMap**, Phase C subs (or full C fallback), **phaseIngredientRoles**, canonical flow LLM, D — **8+** JSON calls; retries add more.

### 7.2 Fallback: `mergeRecipesIntelligent` (`lib/aiMerge.ts`)

1. **Preferred:** **`synthesizeRecipeFromVersions`** → full **phased** pipeline (same order as web create: A → … → canonical → D + recoveries).
2. **If that returns null:** **chef restructure** on combined ingredient/step strings, then **`applyFinalStructuredSteps`**, which runs **`canonicalizeStepFlow`** (per-source steps as pseudo–**`step_candidates`**) → **`finalizeStructuredSteps`** with **`canonicalSpine`** → **`polishRecipeSteps`**. Missing spine → **emergency 3-stage** plan + **FATAL** log (steps still authored with spine, not raw-only).

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

`[extract]`, `[pipeline]`, `[OpenAI]`, **`[ingredient-canonicalization]`** (`raw_count`, `canonical_count`, `clusters_formed`), **`[synthesis-phased:B]`**, **`[synthesis-phased:playbook]`**, **`[synthesis-phased:consensus]`**, **`[synthesis-phased:C]`**, **`[synthesis-phased:roles]`**, **`[synthesis-phased:canonical-flow]`**, **`[synthesis-phased:D]`**, **`[dynamic-playbook]`**, **`[recipeDiffAi]`**, **`[extract-from-extension]`**, **`[merge-decision]`**, `[merge]`.

---

## 13. Diagrams

### Web create

```text
ingest (parallel)
      → historySources[] + historyRawTexts[]
      → synthesizeRecipeFromCombinedRawWithExtractions
            A → B → playbook → consensus → canonicalize → roleMap → C → roles → canonical flow → D → finalize
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
Dynamic playbook ──► family + expected_flow + dish_anchors + materialize → merge essentials
      ▼
Numbered ingredient lines (sourceIndex + sourceConf)
      ▼
Consensus ──► clusters + formatted block (for Phase C LLM passes only)
      ▼
canonicalizeIngredients ──► one entity per concept (canonical_name, variants[], type)
      ▼
phasePreCIngredientRoleMap ──► role per raw line
      ▼
Phase C ──► buildIngredientSignalsFromCanonical → rebucket retries
           → signalsToStructuredGroups → enforceAnchorsInCore
           → postCanonicalIngredientCleanup → phaseCSubstitutionsOnly
           (or phaseCIngredients fallback)
      ▼
phaseIngredientRoles ──► roles for Phase D playbook text
      ▼
Canonical flow ──► cluster step_candidates → dominant_flow (+ tips/warnings/variants)
      ▼
Phase D ──► strict LLM steps OR emergency steps from canonical stages
      ▼
finalizeSynthesisPayload (optional sort/trim; polishRecipeSteps)
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

## 14. Ingredient pipeline (canonicalization + scoring)

### 14.1 Canonicalization (`ingredientCanonicalization.ts`)

| Piece | Rule |
|-------|------|
| **Input** | All Phase A ingredient lines with **sourceIndex** and **sourceConf**. |
| **Cluster key** | **`normalizeIngredientName`** on coerced ingredient name; if short, **stemFromLine** (qty/unit stripped) or **cleaningKey**. |
| **Entity** | **`canonical_name`** refined from first variant then best-display normalize; **`variants[]`** = every raw occurrence; **`ingredient_type`** = heuristic (protein, dairy, starch, liquid, sweetener, flavor, other). |
| **Dedupe** | Only here + **postCanonicalIngredientCleanup** (core uniqueness + optional/core overlap). |

### 14.2 Scoring (`buildIngredientSignalsFromCanonical`)

Each **canonical entity** → one **`IngredientSignal`** (**`name`** = canonical display).

| Field | Source |
|-------|--------|
| **frequency** | Count of distinct **sourceIndex** in **variants**. |
| **confidence_score** | Max **CONF_TO_SCORE** per contributing source. |
| **role** | Best **roleScore** across variants via **lookupRole(line, roleByLine)**. |
| **anchor_match** | **`anchorTokenMatch(canonical_name, anchorTokens)`** OR **`materializedMatchesCanonicalName(canonical_name, materialized)`** — never raw variant text alone. |
| **best_line** | Variant line from highest-confidence source (display quantity). |

| Component | Weight / rule |
|-----------|----------------|
| **frequency_score** | `min(100, frequency × 30)` |
| **confidence_score** | high 100 … low 30 |
| **role_score** | protein/structure 100; base/coating 85; cooking_medium 80; flavor/aroma/richness 50; garnish/optional_enhancement 20 |
| **anchor_score** | 100 if match else 0 |
| **total_score** | `0.3×freq + 0.2×conf + 0.25×role + 0.25×anchor`; if **anchor_match** ⇒ **≥ 85** |
| **Buckets** | core ≥ **coreScoreMin** · optional [30, **coreScoreMin**) · ignore &lt;30 |

**signalsToStructuredGroups:** output **`ing.name`** = signal **canonical name**; dedupe keys by normalized canonical name; caps core 14 / optional 16.

### 14.3 Phase C validation (`phaseCFixReason`)

Triggers retry (rebucket or **phaseCIngredients**): missing **profile.essential_ingredients**; **validateAnchorCoreCoverage**; essentials listed only in optional; protein in optional when anchor requires protein; frying oil only in optional; **duplicateNormalizedInCore**; same normalized name in core and optional; (when not skipped) core lines from **low**-confidence-only sources without essential/signature/anchor support.

### 14.4 Merge diffs

**`computeIngredientScoreDiffNotes`** compares **`ingredient_signals`** (name, **total_score**, bucket, **anchor_match**, frequency) before/after merge → **`key_improvements`** / **`last_diff.ingredient_score_notes`**.

---

## 15. Step flow canonicalization (reference)

**Module:** **`lib/stepFlowCanonicalization.ts`**.

| Piece | Role |
|-------|------|
| **`actionPhaseBucket`** | Classifies a line: marinate, fry, prep, assemble, other — guides clustering. |
| **`clusterStepCandidates`** | Merges similar lines; same-phase lines use a lower Jaccard threshold. |
| **`stripSourceScaffoldingLine` / `sanitizeCanonicalPlan`** | Removes “To marinate / For the sauce …” from plan text. |
| **`canonicalizeStepFlow`** | LLM chooses one **dominant_flow**; fallback ties to best source + **expected_flow**. |
| **`ensureCanonicalPlanHasStages`** | If &lt;3 stages, fill from **expected_flow** or generic prep/cook/serve. |
| **`formatCanonicalPlanForPhaseD`** | Text block passed into Phase D as mandatory spine. |

**Merge fallback** uses the same canonicalization so structured merge steps never ignore single-flow discipline.

### 15.1 Phase D step validation (`collectStepValidationIssues`)

Runs after **injectFamilyMandatorySteps** / clamp. Failure messages feed the next **phaseDAuthoring** retry.

| Check | Intent |
|-------|--------|
| Step count | ≥5 and ≤12 (strict); band **min–max** from playbook also used upstream. |
| **missingCoreInSteps** | Every **core** ingredient name must appear in step text. |
| **validateStepsVsIngredients** | Optional/core usage consistency (e.g. no orphan mentions). |
| **validateSingleFlowOrder** | One coherent sequence (no parallel “recipe A / recipe B”). |
| **detectMultiRecipeMergeIssues** | Catches merged multi-recipe wording. |
| Titles | No duplicate titles; no repeated action fingerprints in titles (e.g. multiple “Fry”). |
| Instructions | No back-to-back duplicate bodies; no banned blog-style titles; not vague (“mix everything”); length/sentence caps. |
| Time / duration | Each step needs **time_minutes** / **duration_minutes** or text cue (until…, N min, preheat, °F, etc.). |

---

## 16. Future-friendly

Auth / RLS, platform APIs, mobile share, grocery lists.

---

*Last updated: **§2.2 / §7.1 / §13 / §14** full synthesis + ingredient pipeline (**canonicalize → score → cleanup**); **finalizeSynthesisPayload** (no ingredient dedupe); **`[ingredient-canonicalization]`** logs; Phase D emergency steps; **`RECIPE_WORKSPACE.md`** / **`MERGE_REVIEW_FLOW.md`**.*
