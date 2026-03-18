import { load } from "cheerio";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { Confidence, ExtractedRecipe } from "./types";
import { parseIngredientLine } from "./ingredientParser";
import { parseServingsCount, servingsDisplayLabel } from "./ingredientScale";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const FETCH_OPTS = {
  headers: BROWSER_HEADERS,
  signal: AbortSignal.timeout(30000),
};

/** Strong signals only — never block large HTML pages */
const STRICT_CLOUDFLARE_CHALLENGE =
  /cf-browser-verification|challenge-form|cdn-cgi\/(?:l\/)?challenge/i;

const MIN_HTML_FORCE_TEXT = 2000;

const SECTION_KEYWORDS =
  /ingredients?|instructions?|method|how to (make|cook)|recipe|directions?|preparation|steps?/i;

export type WebsiteExtractDebug = {
  htmlLength: number;
  cleanedLength: number;
  jsonLdFound: boolean;
  preview: string;
};

export type WebsiteExtractResult = {
  ok: boolean;
  raw_text: string;
  confidence: Confidence;
  error?: string;
  debug: WebsiteExtractDebug;
  /** When JSON-LD Recipe yields structured data — bypass OpenAI */
  recipeFromJsonLd?: ExtractedRecipe | null;
};

function isRecipeType(t: unknown): boolean {
  if (t == null) return false;
  const list = Array.isArray(t) ? t : [t];
  return list.some((x) => String(x).toLowerCase().includes("recipe"));
}

function flattenInstructions(inst: unknown): string[] {
  if (inst == null) return [];
  if (typeof inst === "string") {
    const s = inst.trim();
    return s ? [s] : [];
  }
  if (Array.isArray(inst)) {
    return inst.flatMap((x) => flattenInstructions(x));
  }
  const o = inst as Record<string, unknown>;
  if (typeof o.text === "string" && o.text.trim())
    return [o.text.trim()];
  if (typeof o.name === "string" && o.name.trim()) return [o.name.trim()];
  if (o.itemListElement) return flattenInstructions(o.itemListElement);
  return [];
}

function normalizeIngredients(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => {
      if (typeof x === "string") return x.trim();
      if (x && typeof x === "object" && "name" in x)
        return String((x as { name?: string }).name ?? "").trim();
      return "";
    })
    .filter(Boolean);
}

/** Deep walk: @graph, mainEntity, nested — find every Recipe node */
function collectRecipeNodes(node: unknown, out: Record<string, unknown>[]): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) collectRecipeNodes(x, out);
    return;
  }
  const o = node as Record<string, unknown>;
  if (isRecipeType(o["@type"])) out.push(o);
  for (const k of Object.keys(o)) {
    if (k === "@context") continue;
    collectRecipeNodes(o[k], out);
  }
}

function recipeNodeToExtracted(node: Record<string, unknown>): ExtractedRecipe {
  const title =
    String(node.name ?? node.headline ?? "Recipe").trim() || "Recipe";
  const description = node.description
    ? String(node.description).slice(0, 3000)
    : "";
  const ingStrings = normalizeIngredients(
    node.recipeIngredient ?? node.ingredients
  );
  const ingredients = ingStrings.map((s) => parseIngredientLine(s));
  const steps = flattenInstructions(
    node.recipeInstructions ?? node.instructions
  );
  const cook = node.totalTime ?? node.cookTime ?? node.prepTime;
  const y = node.recipeYield;
  const yieldLabel =
    y != null ? (Array.isArray(y) ? y.map(String).join(", ") : String(y)) : "";
  const servings_base = parseServingsCount(yieldLabel) ?? 1;
  const servings =
    yieldLabel.trim() || servingsDisplayLabel(servings_base);
  return {
    title,
    description,
    ingredients,
    steps,
    estimated_time: typeof cook === "string" ? cook : "—",
    servings,
    servings_base,
  };
}

function recipeNodeToText(node: Record<string, unknown>): string {
  const ex = recipeNodeToExtracted(node);
  const lines = [
    `Recipe: ${ex.title}`,
    ex.description ? `Description: ${ex.description}` : "",
    "Ingredients:",
    ...ex.ingredients.map((i) => `- ${i.original || i.name}`),
    "Instructions:",
    ...ex.steps.map((t, i) => `${i + 1}. ${t}`),
  ].filter(Boolean);
  return lines.join("\n");
}

function scoreRecipeNode(node: Record<string, unknown>): number {
  const ing = normalizeIngredients(
    node.recipeIngredient ?? node.ingredients
  ).length;
  const st = flattenInstructions(
    node.recipeInstructions ?? node.instructions
  ).length;
  return ing * 15 + st * 10 + (ing + st > 0 ? 100 : 0);
}

export type JsonLdScanResult = {
  raw_text: string;
  extracted: ExtractedRecipe;
} | null;

export function scanJsonLdRecipes(html: string): JsonLdScanResult {
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  let bestNode: Record<string, unknown> | null = null;
  let bestScore = -1;

  while ((match = re.exec(html)) !== null) {
    const rawScript = match[1].trim();
    if (!rawScript) continue;
    try {
      const json = JSON.parse(rawScript);
      const recipes: Record<string, unknown>[] = [];
      collectRecipeNodes(json, recipes);
      for (const r of recipes) {
        const sc = scoreRecipeNode(r);
        if (sc > bestScore) {
          bestScore = sc;
          bestNode = r;
        }
      }
    } catch {
      /* skip */
    }
  }

  if (!bestNode || bestScore < 0) return null;
  const extracted = recipeNodeToExtracted(bestNode);
  const raw_text = recipeNodeToText(bestNode);
  if (raw_text.length < 15) return null;
  return { raw_text: raw_text.slice(0, 50000), extracted };
}

export function extractJsonLdRecipeFromHtml(html: string): string | null {
  const r = scanJsonLdRecipes(html);
  return r?.raw_text ?? null;
}

function stripNoiseWithCheerio(html: string) {
  const $ = load(html);
  $(
    "script, style, nav, footer, iframe, noscript, aside, form, " +
      "[class*='comment'], [id*='comment'], [class*='newsletter'], [id*='newsletter'], " +
      "[class*='subscribe'], [class*='sidebar'], [class*='related-post'], .ad, [class*='advertisement']"
  ).remove();
  return $;
}

function extractRecipeSections(html: string): string {
  const $ = load(html);
  const parts: string[] = [];
  $("h1, h2, h3, h4").each((_, el) => {
    const heading = $(el).text().trim();
    if (!SECTION_KEYWORDS.test(heading)) return;
    const chunk: string[] = [heading];
    let sib = $(el).next();
    let guard = 0;
    while (sib.length && guard++ < 200) {
      const tag = sib.prop("tagName")?.toLowerCase() ?? "";
      if (/^h[1-4]$/i.test(tag)) break;
      const t = sib.text().trim();
      if (t) chunk.push(t);
      sib = sib.next();
    }
    if (chunk.length > 1) parts.push(chunk.join("\n"));
  });
  return parts.join("\n\n").slice(0, 30000);
}

function readabilityText(html: string, url: string): string {
  try {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    const reader = new Readability(doc);
    const article = reader.parse();
    if (article?.textContent?.trim()) return article.textContent.trim();
  } catch {
    /* ignore */
  }
  return "";
}

function bodyFallbackText(html: string): string {
  try {
    const $ = stripNoiseWithCheerio(html);
    return $("body").text().replace(/\s+/g, " ").trim().slice(0, 50000);
  } catch {
    return "";
  }
}

export async function extractWebsite(url: string): Promise<WebsiteExtractResult> {
  const debug: WebsiteExtractDebug = {
    htmlLength: 0,
    cleanedLength: 0,
    jsonLdFound: false,
    preview: "",
  };

  console.log("[extract] ---- SOURCE START ----");
  console.log("[extract] URL:", url);

  let html = "";
  try {
    const res = await fetch(url, FETCH_OPTS);
    html = await res.text();
    debug.htmlLength = html.length;

    console.log("[extract] HTML LENGTH:", html.length);
    console.log(
      "[extract] HTML PREVIEW:",
      html.slice(0, 500).replace(/\s+/g, " ")
    );

    /* Large pages: always try extraction (never abort as "challenge") */
    const isHardChallenge =
      html.length < MIN_HTML_FORCE_TEXT &&
      STRICT_CLOUDFLARE_CHALLENGE.test(html);

    if (isHardChallenge) {
      debug.preview = html.slice(0, 500);
      console.log("[extract] ---- SOURCE END (challenge, short HTML) ----");
      return {
        ok: false,
        raw_text: "",
        confidence: "low",
        error: "Challenge or blocked page (short HTML)",
        debug,
      };
    }

    if (!res.ok && html.length < MIN_HTML_FORCE_TEXT) {
      debug.preview = html.slice(0, 500);
      console.log("[extract] ---- SOURCE END (HTTP, short body) ----");
      return {
        ok: false,
        raw_text: "",
        confidence: "low",
        error: `HTTP ${res.status}`,
        debug,
      };
    }

    const jsonLdResult = scanJsonLdRecipes(html);
    if (jsonLdResult) {
      const { raw_text, extracted } = jsonLdResult;
      debug.jsonLdFound = true;
      debug.cleanedLength = raw_text.length;
      debug.preview = raw_text.slice(0, 500);
      const hasStructured =
        extracted.ingredients.length > 0 || extracted.steps.length > 0;

      console.log("[extract] CLEAN TEXT LENGTH:", raw_text.length);
      console.log(
        "[extract] CLEAN TEXT PREVIEW:",
        raw_text.slice(0, 500).replace(/\s+/g, " ")
      );
      console.log(
        "[extract] JSON-LD structured — ingredients:",
        extracted.ingredients.length,
        "steps:",
        extracted.steps.length,
        hasStructured ? "(OpenAI bypass)" : "(will refine via OpenAI)"
      );
      console.log("[extract] ---- SOURCE END ----");

      return {
        ok: true,
        raw_text,
        confidence: "high",
        debug,
        recipeFromJsonLd: hasStructured ? extracted : null,
      };
    }

    const readText = readabilityText(html, url);
    const sectionText = extractRecipeSections(html);
    const $ = stripNoiseWithCheerio(html);
    const mainSel = $(
      "main, article, [role='main'], .entry-content, .post-content, .recipe-card, #recipe, .wprm-recipe-container, .tasty-recipes"
    );
    const mainText =
      mainSel.length > 0
        ? mainSel.first().text()
        : $("body").text();
    const cleanedMain = mainText.replace(/\s+/g, " ").trim();

    const pieces = [readText, sectionText, cleanedMain].filter(
      (p) => p && p.length > 40
    );
    let combined = Array.from(new Set(pieces)).join("\n\n");
    if (combined.length < 80) {
      combined = cleanedMain || readText || sectionText || "";
    }
    combined = combined.replace(/\s+/g, " ").trim().slice(0, 50000);

    if (combined.length < 200 && html.length > MIN_HTML_FORCE_TEXT) {
      const fb = bodyFallbackText(html);
      if (fb.length > combined.length) combined = fb;
    }
    if (combined.length < 100 && html.length > MIN_HTML_FORCE_TEXT) {
      combined = bodyFallbackText(html) || combined;
    }

    if (combined.length < 1 && html.length > MIN_HTML_FORCE_TEXT) {
      combined = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 50000);
    }

    debug.cleanedLength = combined.length;
    debug.preview = combined.slice(0, 500);

    console.log("[extract] CLEAN TEXT LENGTH:", combined.length);
    console.log(
      "[extract] CLEAN TEXT PREVIEW:",
      combined.slice(0, 500).replace(/\s+/g, " ")
    );
    console.log("[extract] ---- SOURCE END ----");

    if (combined.length < 1) {
      return {
        ok: false,
        raw_text: "",
        confidence: "low",
        error: "No extractable text",
        debug,
      };
    }

    return {
      ok: true,
      raw_text: combined,
      confidence: readText.length > 500 ? "high" : "medium",
      debug,
      recipeFromJsonLd: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Fetch failed";
    debug.preview = html.slice(0, 500);
    console.log("[extract] ---- SOURCE END (error):", msg, "----");
    return {
      ok: false,
      raw_text: "",
      confidence: "low",
      error: msg,
      debug,
    };
  }
}
