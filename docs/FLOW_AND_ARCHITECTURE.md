# Recipe Cloud — Flow & architecture documentation

This document describes how the app works end-to-end, with emphasis on **content extraction**, **Recipe Builder**, and **when OpenAI runs vs. when it is skipped**.

---

## 1. Product overview

**Recipe Cloud** saves recipes by:

- Pasting **one or more URLs** and/or **images** on **`/create`**.
- Using the **Chrome extension** as a **Recipe Builder**: create a recipe from the current page, then **add more pages** to the same recipe while browsing.

**Pipeline (web create):** per source → fetch/synthesize **`raw_text`** → structured recipe with **parsed ingredients** (often **JSON-LD only**, no AI) or **`extractRecipe` (OpenAI)** → collect successes → **merge** if 2+ → **Supabase**.  
**Extension:** DOM text → **`/api/extract-from-extension`** → create or **merge into** an existing recipe.

Design goals:

- **Partial success:** URLs are processed with **`Promise.allSettled`**; one failure does not abort others.
- **Success if partial:** a source counts as **success** if it has **ingredients *or* steps** (not both required).
- **No dead end:** if **every** source fails structurally, **`/api/recipes/create`** still inserts a **draft** row (`needs_user_input`, empty lists, `raw_text` when available) so the user can proceed.
- **JSON-LD first:** many blogs expose `Recipe` in **`application/ld+json`**; the server builds title/ingredients/steps **directly from schema** and **skips OpenAI** for that URL when structured data exists.
- **Structured ingredients + scaling:** each ingredient is stored as **`{ quantity, unit, name, original }`** (with **`servings_base`** on the row). The recipe page rescales quantities **in the browser** (no API) when the user changes servings.

---

## 2. Tech stack (reference)

| Layer        | Technology                          |
|-------------|-------------------------------------|
| Web app     | Next.js 14 (App Router), TypeScript |
| Styling     | TailwindCSS                         |
| Database    | Supabase (Postgres + optional Auth) |
| Ingredient math | `lib/ingredientParser.ts`, `lib/ingredientScale.ts` (parse, `roundSmart`, scale) |
| AI          | OpenAI API (`gpt-4o-mini`)          |
| Blog HTML   | Cheerio, Mozilla Readability, JSDOM |
| YouTube     | `youtube-transcript` + page HTML    |
| Extension   | Chrome MV3 (popup + options)        |
| Deploy      | Vercel (typical)                    |

---

## 3. User-facing entry points

### 3.1 Web: Create recipe (`/create`)

1. User adds **URLs** (multi-link) and/or **images**.
2. Optional **dish name** (title hint).
3. **Create Recipe** → **`POST /api/recipes/create`** runs **all URL and image ingests in parallel** (`Promise.allSettled`), then merges successful extractions.
4. **Success (≥1 structured source):** **“We extracted X of Y sources”** + per-source ✓/✗, optional **ingredient/step counts**, **Open recipe**.
5. **All sources failed structurally:** response still includes **`id`** (**draft**), **`is_draft: true`**, **`sources[]`** with debug fields — UI shows **“Draft saved”** and user can open the recipe or add content later (not a hard 422 block).

### 3.2 Web: Dashboard (`/dashboard`)

- **“Your saved recipes”** — list ordered by **`updated_at`** (fallback `created_at`).
- Each card: **title**, **source count**, **last updated** date.

### 3.3 Web: Recipe view (`/recipe/[id]`)

- **Ingredients:** **Core** (cross-source) vs **Optional** (single-source). Stored as structured objects: **`quantity`**, **`unit`**, **`name`**, **`original`** (fallback line). Legacy string rows are parsed on read.
- **Servings & scaling:** Column **`servings_base`** (default 1) is the numeric base; header shows human **`servings`**. **Adjust servings** (− / +) rescales ingredient quantities client-side with **`roundSmart`**. Toggle **Show scaled** vs **Show original**; optional **2 lb → 10 lb** hint when scaled.
- **Steps:** numbered list (merged / rewritten when multi-source).  
- **Tips:** bottom section when **`tips[]`** non-empty.  
- Draft / empty banner when **`needs_user_input`** or no content.  
- Optional **`?from_reel=1`** banner.

### 3.4 Chrome extension (Recipe Builder)

**On popup open:** `GET /api/recipes?limit=5` loads recent recipes for the picker.

**Storage (`chrome.storage.local`):** `activeRecipeId`, `activeRecipeTitle`, source count — updated after every successful add (the recipe you added to becomes active).

**UI — Add this page to:**

- **Current recipe** (if an active recipe is set)
- **Recent recipes** (up to 5, with source counts)
- **Create new recipe** (+ optional name field)

One **Add this page** button. Payload always includes `recipeId` when merging into an existing row; omit `recipeId` only for **Create new**.

| After save | UI |
|------------|-----|
| Success | **Added to [title]**, recipe updated, **View recipe**, **Add another source** (returns to picker) |

**DOM capture (injected):** `p`, `span`, **`li`**, `h1`–`h3`, `div[role="article"]`; exclude nav/footer; **visible nodes only**; each chunk **40–500** characters; dedupe; concatenate, **cap 5000** chars. If too little: looser chunks, then **`body.innerText`** slice to 5000 so **`raw_text` is rarely empty**.

**API:** `POST /api/extract-from-extension`  
**Body:** `{ raw_text, source_url, platform, recipeId? , recipe_name? }`

- **No `recipeId`:** insert new recipe (draft if `raw_text` very short).
- **With `recipeId`:** load row, append source URL, **`mergeRecipesIntelligent`** when text is long enough; update row (**`servings_base`** unchanged on merge).

---

## 4. Link classification (routing)

**`classifyLink(url)`** (`lib/classifyLink.ts`):

| Platform      | Strategy        |
|---------------|-----------------|
| YouTube       | `youtube`       |
| TikTok, IG, FB, XHS | `reel_fallback` |
| **Default**   | **`html_parse`**|

---

## 5. Backend: fetching & structured output by content type

A source ends as **`ExtractedRecipe`**: **title**, **`ingredients[]`** (each item **`StructuredIngredient`**: `quantity` | null, `unit`, `name`, `original`), **`steps[]`**, **`servings`** (display string), **`servings_base`** (positive integer, default **1**), plus **description** / **estimated_time** where available.

**Success rule:** **`ingredients.length > 0 || steps.length > 0`**. Never require both.

---

### 5.1 Websites / blogs (`html_parse`)

**Module:** `lib/websiteExtract.ts`

1. **Fetch** — Browser-like **User-Agent**, **~30s** timeout.
2. **Challenge pages** — Only when **HTML length &lt; ~2000** **and** body matches strong signals (**`cf-browser-verification`**, **`challenge-form`**, **`cdn-cgi/.../challenge`**). **Large HTML is never discarded** as “challenge only.”
3. **Short body + HTTP error** — Fail if body &lt; 2000. Otherwise continue parsing.
4. **JSON-LD `Recipe` (highest priority)**  
   - Every `<script type="application/ld+json">` parsed; **deep walk** (`@graph`, **`mainEntity`**, nested objects) to find **`@type` Recipe**.  
   - Best node chosen by score (ingredient/step counts).  
   - **`recipeIngredient`**, **`recipeInstructions`** (strings, **HowToStep**, **itemListElement**, etc.) → **arrays**.  
   - Each ingredient string is passed through **`parseIngredientLine`** → structured **`{ quantity, unit, name, original }`** (ranges / “to taste” / mixed units stay unscaled with **`original`**).  
   - **`recipeYield`** → **`servings`** label + **`servings_base`** (first number parsed, else **1**).  
   - **`scanJsonLdRecipes`** returns **`raw_text`** (human-readable) + **`ExtractedRecipe`**.  
   - If **ingredients or steps** exist → pipeline sets **`recipeFromJsonLd`** → **`ingestUrl` succeeds without calling OpenAI** (`from_json_ld: true` on report).
5. **No usable JSON-LD** — **Readability** + **Cheerio** headings matching **ingredients | instructions | directions | method | how to make | recipe | preparation | steps** + main/article/entry-content + **body fallback** if needed; combined, **~50k** cap.

**Logging:** `[extract]` — URL, HTML length/preview, clean length/preview, JSON-LD ingredient/step counts and whether OpenAI is bypassed.

---

### 5.2 YouTube (`youtube`)

**`lib/extractionStrategies.ts` → `strategyYoutube`**

Transcript → else page **`shortDescription`**, **og:title**, meta description → else **placeholder** instructing inference. Feeds **`extractRecipe`** when used from **`ingestUrl`**.

---

### 5.3 Reels / social (`reel_fallback`)

Placeholder **`raw_text`** only; **OpenAI** tries to infer steps/ingredients. **Low** confidence.

---

### 5.4 Images

**Vision** → plain text → **`extractRecipe`** for normalized JSON.

---

### 5.5 OpenAI extraction (`extractRecipe`)

**Module:** `lib/aiExtractor.ts`

- **System:** instructs structured JSON with numeric quantities where possible.
- **User:** strict JSON **`{ title, servings (number), ingredients[], steps[] }`**. Each ingredient object: **`quantity`** (number or null), **`unit`**, **`name`**, **`original`** (full line). Ranges / unparseable lines → **`quantity: null`**, preserve **`original`**.
- **`servings_base`:** from model **`servings`** if valid; else **1**. Display **`servings`** string via **`servingsDisplayLabel(servings_base)`**.
- **`JSON.parse`** in **try/catch**; **`coerceStructuredIngredient`** normalizes each item (AI objects or legacy strings).
- **Heuristics (no key or fallback):** bullet lines and measure-like lines → **`parseIngredientLine`** (`lib/ingredientParser.ts`): fractions **`1/2`**, **`1 1/2`**, unicode ½, units (**cup, tbsp, tsp, lb, g, ml, …**). **“To taste”**, **1–2 tbsp**-style ranges, **two measures in one line** → no numeric scale; show **`original`**.
- **Last resort:** paragraph split → numbered steps so long **`raw_text`** rarely yields both arrays empty.
- **Logs:** **`[OpenAI] FULL RAW RESPONSE:`** (full message body before parse).

**No API key:** heuristics + last resort only.

---

## 6. Per-source pipeline (`lib/sourcePipeline.ts`)

**Used by:** `POST /api/recipes/create` (via **`Promise.allSettled`** per URL and per image).

For each **URL**:

1. **`classifyLink`** → strategy.  
2. **`html_parse`:** **`extractWebsite`**. If **`recipeFromJsonLd`** has content → **return success immediately** (no OpenAI). Else **`extractRecipe(raw_text)`**.  
3. **YouTube / reel:** build **`raw_text`** → **`extractRecipe`**.  
4. **`SourceExtractionReport`:** `source_url`, `platform`, `status`, `confidence`, **`ingredients_count`**, **`steps_count`**, **`from_json_ld?`**, **`raw_text`** preview (~500), `error?`.

**Images:** Vision → **`extractRecipe`**.

**Logs:** **`[pipeline]`** — source URL, raw length + preview, parsed counts; JSON-LD branch logs OpenAI bypass.

---

## 7. Intelligent merge & save (`lib/aiMerge.ts` + `POST /api/recipes/create`)

**`mergeRecipesIntelligent(sources)`** builds the final stored recipe:

1. **Ingredients (`recipeIngredients.ts`)**  
   - Items are **`StructuredIngredient`** (or coerced from strings).  
   - **Normalize key** from **`name` / `original`** (strip quantities/units for overlap).  
   - **2+ sources:** same key in **≥2 sources** → **`core`**; **1 source only** → **`optional`**.  
   - **1 source:** deduped by key → all → **`core`**, **`optional`** empty.  
   - On duplicate key, keep the richer line (e.g. has **`quantity`**) / higher-confidence source.

2. **Steps (not a blind array merge)**  
   - All per-source steps are combined into one **labeled text block** (source index + confidence + title).  
   - **OpenAI** rewrites into a single ordered **`steps[]`**: dedupe, clear instructions, section headings turned into real steps.  
   - If the API fails or no key: **deduped concat** fallback.

3. **Tips**  
   - Same OpenAI pass returns **`tips[]`**: repeated techniques → important tips; unique helpful notes → enhancements.  
   - Single-source saves: **`tips`** usually empty.

4. **Servings base for merge**  
   - **`servings_base`** on merged output = **max** of sources’ **`servings_base`** (each ≥ 1).  
   - **`servings`** string labels that base (e.g. **“4 servings”**).

**Stored shape (DB row — relevant fields):**

```json
{
  "title": "...",
  "description": "...",
  "ingredients": {
    "core": [
      { "quantity": 2, "unit": "lb", "name": "beef shank", "original": "2 lb beef shank" }
    ],
    "optional": []
  },
  "steps": ["..."],
  "tips": ["..."],
  "estimated_time": "...",
  "servings": "4 servings",
  "servings_base": 4
}
```

**Recipe page scaling (client only):** **`scaleIngredients(list, servings_base, targetServings)`** in **`lib/ingredientScale.ts`** — **`roundSmart`** on scaled amounts. Unparseable lines (**`quantity` null**) always display **`original`**. Not persisted when the user moves the servings slider.

| Successful sources | Action |
|--------------------|--------|
| **0** | Draft row: empty **`core`/`optional`**, **`tips: []`**. |
| **≥ 1** | **`mergeRecipesIntelligent`** (1 source = structured single recipe; 2+ = full merge). |

**Legacy rows:** flat **`ingredients` array** of strings → read as **`{ core: [...parsed], optional: [] }`**. String **`core`/`optional`** entries → **`coerceStructuredIngredient`** / **`parseIngredientLine`** on read (`parseRecipeFromDb.ts`). **`servings_base`:** column if present; else inferred from **`servings`** text; else **1**.

**Response (success):** `id`, `from_reel`, `sources[]`, `extracted_count`, `total_count`, optional **`is_draft`**.

---

## 8. Extension API (`POST /api/extract-from-extension`)

| Field | Role |
|-------|------|
| `raw_text` | DOM capture from extension |
| `source_url`, `platform` | Provenance |
| `recipeId` | If set → **merge** into existing row |
| `recipe_name` | Optional title for **new** recipe |

Weak **`raw_text`** → draft row; merge path appends sources and runs **`mergeRecipesIntelligent`** (same core/optional/steps/tips pipeline).

**Merge into existing (`recipeId`):** **`servings_base`** and **`servings`** on the row are **preserved** after update so the user’s scaling baseline does not jump when new sources are added; merged ingredient quantities reflect the combined content.

---

## 9. Other API routes

| Route | Role |
|-------|------|
| `GET /api/recipes?limit=5` | Recent recipes for extension picker (`id`, `title`, `source_count`, `updated_at`). CORS enabled. |
| `DELETE /api/recipes/[id]` | Delete recipe (dashboard + extension-capable). CORS enabled. |
| `POST /api/recipes/create` | Multi-URL/image create (parallel ingest, merge/draft). |
| `POST /api/extract-from-extension` | Extension create or **merge into** `recipeId` (never creates when `recipeId` set). CORS + OPTIONS. |
| `POST /api/extract` | Single-URL debug extract. |
| `POST /api/merge` | Merge recipe JSON array. Incoming recipes may use **string[]** or structured **`ingredients`**; normalized before merge. |

---

## 10. Database (`recipes`)

- **`ingredients`** (jsonb): **`{ "core": [...], "optional": [...] }`** where each element is ideally **`{ quantity, unit, name, original }`**. Legacy **string[]** or flat array still supported on read.  
- **`steps`** (jsonb): string array.  
- **`tips`** (jsonb): string array — merge insights / enhancements.  
- **`servings_base`** (numeric): default **1** — numeric base for UI ingredient scaling.  
- Plus: `title`, `description`, `estimated_time`, **`servings`** (human label), **`source_urls`**, **`source_platforms`**, **`raw_text`**, **`created_at`**, **`needs_user_input`**, **`updated_at`**.

Migrations: **`20250318000000_recipe_builder.sql`**, **`20250319000000_recipe_tips_grouped_ingredients.sql`** (`tips`), **`20250320000000_servings_base.sql`** (**`servings_base`**).

---

## 11. Environment variables

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`  
- `OPENAI_API_KEY`  

Extension must target a reachable app URL (options + optional host permission).

---

## 12. Debugging (server logs)

| Prefix | Meaning |
|--------|---------|
| `[extract]` | Website fetch + JSON-LD / clean text |
| `[pipeline]` | Per-source ingest, raw preview, final parsed counts |
| `[OpenAI]` | Full model JSON string before parse |

Smoke test (blogs): **`npm run test:blogs`** (`scripts/quick-extract-test.ts` — logs ingredient/step counts; structured ingredients in AI path).

---

## 13. Mental model (diagram)

```text
URLs + images
      │
      ▼
┌─────────────────────────────────────┐
│ Promise.allSettled (per URL / image) │
└─────────────────────────────────────┘
      │
      ▼
classifyLink → html_parse | youtube | reel_fallback | image
      │
      ▼
html_parse: extractWebsite
      │
      ├─► JSON-LD Recipe with ing/steps? ──► structured recipe (NO OpenAI)
      │
      └─► else raw_text ──► extractRecipe (OpenAI + heuristics)
      │
      ▼
Collect successes (ing OR steps)
      │
      ├─► 0 ──► insert DRAFT + still return id
      ├─► 1 ──► save
      └─► 2+ ──► mergeRecipesIntelligent ──► save (+ servings_base)
      │
      ▼
Supabase + UI (create summary / recipe / dashboard)
```

**Extension parallel path:** DOM → **`extract-from-extension`** → new row or merge into **`activeRecipeId`**.

**Recipe view:** load recipe → **Adjust servings** / **Show scaled | Show original** → client-side **`scaleIngredients`** only (no write).

---

## 14. Future-friendly (not fully built)

- Stronger platform APIs (YouTube Data, oEmbed)  
- Auth / RLS on `recipes`  
- Mobile share targets, grocery lists  

---

*Last updated: structured ingredients (`ingredientParser` / `coerceStructuredIngredient`), **`servings_base`** + client scaling (`ingredientScale`), merge dedupe on structured rows, extension merge preserves servings baseline, DB migration **`20250320000000_servings_base`**, merge API normalization.*
