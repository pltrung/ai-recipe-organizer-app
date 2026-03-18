# Recipe Cloud — Flow & architecture documentation

This document outlines how the app works end-to-end, with emphasis on **how the backend fetches and processes different kinds of content**.

---

## 1. Product overview

**Recipe Cloud** lets users save recipes by:

- Pasting **one or more URLs** (blogs, YouTube, social) and/or **uploading images** on the web app (`/create`).
- Using the **Chrome extension** on any open tab to send visible page text to the API.

The pipeline **fetches or synthesizes text per source**, runs **OpenAI** to turn text into structured recipes, optionally **merges** multiple recipes, saves to **Supabase**, and opens the **recipe page**.

Design goals:

- **Partial success**: one bad link does not kill the whole batch; each URL is processed independently.
- **Never block on a single failure** when at least one source yields a usable recipe.
- **Manual fallback** when no source produces ingredients + steps.

---

## 2. Tech stack (reference)

| Layer        | Technology                          |
|-------------|-------------------------------------|
| Web app     | Next.js 14 (App Router), TypeScript |
| Styling     | TailwindCSS                         |
| Database    | Supabase (Postgres + optional Auth) |
| AI          | OpenAI API (`gpt-4o-mini`)          |
| Blog HTML   | Cheerio, Mozilla Readability, JSDOM |
| YouTube     | `youtube-transcript` + page HTML    |
| Extension   | Chrome MV3 (popup + options)       |
| Deploy      | Vercel (typical)                    |

---

## 3. User-facing entry points

### 3.1 Web: Create recipe (`/create`)

1. User adds **URLs** (multi-link) and/or **images** (screenshots).
2. Optional **“What dish is this?”** (title hint).
3. **Create Recipe** → loading steps → API processes all inputs.
4. **Success**: screen **“We extracted X of Y sources”** with per-source ✓/✗ → **Open recipe**.
5. **All sources failed**: manual form (**ingredients / steps**) + list of failed sources.

### 3.2 Web: Dashboard (`/dashboard`)

- Lists saved recipes from Supabase (title, platforms, link to `/recipe/[id]`).

### 3.3 Web: Recipe view (`/recipe/[id]`)

- Shows merged recipe, source links, optional **from reel** banner (`?from_reel=1`).

### 3.4 Chrome extension

1. User sets **API base URL** in **Extension options** (local `http://127.0.0.1:3000` or Vercel URL + permission).
2. On a normal webpage → popup → **Save recipe from this page**.
3. Injected script collects **visible** `p, li, h1–h3` (excluding nav/footer) → `POST /api/extract-from-extension` → new tab opens recipe.

---

## 4. Link classification (routing)

Every URL passes through **`classifyLink(url)`** (`lib/classifyLink.ts`):

| Platform      | URL patterns                         | Content type      | **Strategy**     |
|---------------|--------------------------------------|-------------------|------------------|
| YouTube       | `youtube.com`, `youtu.be`            | `video` / `short` | `youtube`        |
| TikTok        | `tiktok.com`                         | `reel` / `post`   | `reel_fallback`  |
| Instagram     | `instagram.com`                      | `reel` / `post`   | `reel_fallback`  |
| Facebook      | `facebook.com`, `fb.com`, `fb.watch` | `reel` / `post`   | `reel_fallback`  |
| Xiaohongshu   | `xiaohongshu.com`, `xhslink.com`     | `reel` / `post`   | `reel_fallback`  |
| **Everything else** | —                            | `page`            | **`html_parse`** |

Reel vs post: paths like `/reel/`, `/reels/`, `/shorts/`, `/video/` → treated as reel-type links (same strategy either way).

---

## 5. Backend: fetching & raw text by content type

All paths below produce **`raw_text`** (string) + **confidence** (`high` | `medium` | `low`). That text is then passed to **`extractRecipe(raw_text)`** (OpenAI JSON: title, description, ingredients, steps, time, servings).

A source is **successful** only if the model returns **at least one ingredient or step**.

---

### 5.1 Websites / blogs (`strategy: html_parse`)

**Module:** `lib/websiteExtract.ts` (also used indirectly via `strategyHtmlParse` in `lib/extractionStrategies.ts`).

**Flow:**

1. **HTTP fetch**  
   - GET URL with browser-like `User-Agent` and timeouts (~25s).  
   - Non-OK status → **failed** for that URL only (`error: HTTP …`).

2. **Anti-bot / challenge pages**  
   - If HTML matches patterns (e.g. Cloudflare challenge, captcha hooks, “verify you are human”, “unusual traffic”) → **failed** with a clear error; **other URLs still run**.

3. **JSON-LD `Recipe` schema** (first win)  
   - Scans `<script type="application/ld+json">` for `@type: Recipe` (or array containing Recipe).  
   - Builds structured text: title, description, ingredients list, numbered steps.  
   - **Confidence: high.**  
   - Server logs: `htmlLength`, `cleanedLength`, `jsonLdFound: true`, first ~500 chars of cleaned text.

4. **If no JSON-LD**  
   - **Readability** (`@mozilla/readability` + JSDOM): main article `textContent`.  
   - **Section-aware Cheerio pass**: headings whose text matches **ingredients | instructions | method | how to make | recipe | directions | preparation | steps** → collect following blocks until next heading.  
   - **Noise removal**: strip `nav`, `footer`, `script`, `style`, comments, newsletter/subscribe blocks, sidebars, ads, etc.  
   - Merge **Readability text + section chunks + main/entry-content body** (deduped), cap ~50k chars.  
   - **Confidence:** `high` if Readability text is long, else `medium`.  
   - Logs: `jsonLdFound: false`, lengths, preview.

5. **Too little text** → failed for that URL.

---

### 5.2 YouTube (`strategy: youtube`)

**Module:** `lib/extractionStrategies.ts` → `strategyYoutube`.

**Flow:**

1. Parse **video ID** from watch / youtu.be URL.  
2. **`youtube-transcript`**: fetch captions → join into `[Video transcript]\n…`. **Confidence: medium.**  
3. If transcript too short or missing: **fetch watch page HTML** → extract **`shortDescription`** (JSON in page), **og:title**, **meta description**.  
4. If still almost nothing: return a **low-confidence placeholder** instructing the model to infer from title/patterns (may still yield a weak recipe).

Failure (for multi-link): if usable text is still &lt; ~30 chars after fallbacks, that URL is **failed**; others continue.

---

### 5.3 Reels / social wall posts (`strategy: reel_fallback`)

**Platforms:** Instagram, Facebook, TikTok, Xiaohongshu (and reel-like paths on those domains).

**Flow:**

- **No real fetch** of post body (login walls / anti-scraping).  
- Fixed **placeholder `raw_text`**: “short-form cooking video… transcript unavailable… infer likely recipe…”.  
- **Confidence: low.**  
- OpenAI may still output ingredients/steps (guesswork). If it does, source counts as **success**; if not, **failed**.

---

### 5.4 Images (screenshots)

**Module:** `strategyImage` in `lib/extractionStrategies.ts`.

**Flow:**

- **OpenAI Vision** (`gpt-4o-mini` + image URL) extracts title / ingredients / steps as plain text.  
- That text → **`extractRecipe`** again for normalized JSON.  
- **Confidence: medium/high** based on response length.

---

### 5.5 Chrome extension (separate path)

**API:** `POST /api/extract-from-extension`  
**Body:** `{ raw_text, source_url, platform }` (platform string from client heuristics).

**Flow:**

- Does **not** re-run website/YouTube strategies server-side for that request.  
- **`extractRecipe(raw_text)`** only.  
- Always **inserts a row**: full extraction **or** draft (“Untitled”, empty lists) if text too short / AI empty — so the user always gets a **recipe ID** to edit.

---

## 6. Per-source pipeline (web `/api/recipes/create`)

**Module:** `lib/sourcePipeline.ts` (`ingestUrl`, `ingestImage`).

For **each URL** (in order):

1. `classifyLink` → pick strategy.  
2. Run the appropriate fetch path (§5.1–5.3).  
3. `extractRecipe(raw, OPENAI_API_KEY)`.  
4. Emit **`SourceExtractionReport`**: `source_url`, `platform`, `status` (`success` | `failed`), `confidence`, optional `raw_text` preview (~500 chars), optional `error`.  
5. If ingredients **or** steps exist → attach **`ExtractedRecipeWithConfidence`** for merge.

**Images:** same idea via `ingestImage` (Vision → extractRecipe).

**Important:** Exceptions on one URL do not abort the loop; failed sources get a report and the loop continues.

---

## 7. Merge & save (web create)

**After all sources:**

| Successful recipe objects | Action |
|---------------------------|--------|
| **0**                     | **422** + `sources[]`, `extracted_count`, `total_count` → UI manual fallback. |
| **1**                     | Use that recipe as-is (no merge). |
| **≥ 2**                   | **`mergeRecipesWithConfidence`** — prompt prioritizes **high** confidence, then **medium**, **low** as hints only. |

Then **insert** into Supabase `recipes`: title (optional user override), description, ingredients, steps, times, **`source_urls`** (all submitted URLs), **`source_platforms`**, concatenated **`raw_text`** for debugging.

**Response (success):** `id`, `from_reel`, `sources[]`, `extracted_count`, `total_count`.

---

## 8. API routes (summary)

| Route | Role |
|-------|------|
| `POST /api/recipes/create` | Main flow: URLs + images → per-source ingest → merge/save → JSON + source reports. |
| `POST /api/extract-from-extension` | Extension: raw_text → extract → always save draft or full → `{ recipeId }`. |
| `POST /api/extract` | Single URL extract (legacy/debug). |
| `POST /api/merge` | Merge array of recipes (JSON). |

---

## 9. Database (`recipes` table)

Typical columns:

- `id`, `user_id`, `title`, `description`, `ingredients` (jsonb), `steps` (jsonb), `estimated_time`, `servings`, `source_urls` (jsonb), `source_platforms` (jsonb), `raw_text`, `created_at`.

---

## 10. Environment variables

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`  
- `OPENAI_API_KEY`  

Required for full AI extraction; extension + create need the app reachable at the URL configured in the extension.

---

## 11. Debugging (server)

Website extraction logs lines like:

```text
[RecipeCloud] website <url> | html=<n> cleaned=<m> jsonLd=true|false preview=<first 500 chars>
```

Check Vercel/server logs when a specific blog fails.

---

## 12. Mental model (one diagram)

```text
User input (URLs + images)
        │
        ▼
┌───────────────────┐
│ Per URL / image   │──► classifyLink → website | youtube | reel_fallback | image
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Fetch / synthesize │──► raw_text + confidence
│ raw_text           │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ extractRecipe     │──► structured recipe (or empty)
│ (OpenAI)          │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Collect successes │──► 0 → manual UI
│                   │    1 → save that recipe
│                   │    2+ → mergeRecipesWithConfidence → save
└───────────────────┘
        │
        ▼
   Supabase + redirect / summary UI
```

---

## 13. Future-friendly (not fully built)

Structure supports adding:

- Floating extension button, multi-tab capture  
- Stronger platform APIs (e.g. YouTube Data API, oEmbed)  
- Mobile share targets  
- Grocery lists, richer auth/RLS on `recipes`

---

*Last updated to match the codebase behavior for multi-link partial success, website extraction stack, and Chrome extension options.*
