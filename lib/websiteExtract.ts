import { load } from "cheerio";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { Confidence } from "./types";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const FETCH_OPTS = {
  headers: BROWSER_HEADERS,
  signal: AbortSignal.timeout(25000),
};

/** Only true Cloudflare interstitial / challenge — not beacon/widget on normal pages */
const CLOUDFLARE_CHALLENGE =
  /cf-browser-verification|challenge-platform|__cf_chl_opt|cdn-cgi\/challenge-platform/i;

const MIN_HTML_TO_TRUST_CONTENT = 2000;

function looksLikeCloudflareChallengeOnly(html: string): boolean {
  return CLOUDFLARE_CHALLENGE.test(html);
}

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
};

function logDebug(url: string, html: string, debug: WebsiteExtractDebug) {
  const head500 = html.slice(0, 500).replace(/\s+/g, " ");
  console.log(
    `[RecipeCloud] website ${url} | htmlLength=${debug.htmlLength} | first500=${head500}`
  );
  console.log(
    `[RecipeCloud] website ${url} | cleaned=${debug.cleanedLength} jsonLd=${debug.jsonLdFound} preview=${debug.preview.slice(0, 500).replace(/\s+/g, " ")}`
  );
}

export function extractJsonLdRecipeFromHtml(html: string): string | null {
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1].trim());
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (item["@type"] === "Recipe" || item["@type"]?.includes?.("Recipe")) {
          const name = item.name ?? item.title ?? "Recipe";
          const ing = item.recipeIngredient ?? item.ingredients ?? [];
          const steps = item.recipeInstructions ?? item.instructions ?? [];
          const stepText = steps.map((s: { text?: string; name?: string }) =>
            typeof s === "string" ? s : s?.text ?? s?.name ?? ""
          );
          return [
            `Recipe: ${name}`,
            item.description ? `Description: ${item.description}` : "",
            "Ingredients:",
            ...(Array.isArray(ing) ? ing.map((i: string) => `- ${i}`) : []),
            "Instructions:",
            ...stepText.map((t: string, i: number) => `${i + 1}. ${t}`),
          ]
            .filter(Boolean)
            .join("\n");
        }
      }
    } catch {
      /* skip */
    }
  }
  return null;
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

export async function extractWebsite(url: string): Promise<WebsiteExtractResult> {
  const debug: WebsiteExtractDebug = {
    htmlLength: 0,
    cleanedLength: 0,
    jsonLdFound: false,
    preview: "",
  };

  let html = "";
  try {
    const res = await fetch(url, FETCH_OPTS);
    html = await res.text();
    debug.htmlLength = html.length;

    if (!res.ok) {
      debug.preview = html.slice(0, 500);
      logDebug(url, html, debug);
      return {
        ok: false,
        raw_text: "",
        confidence: "low",
        error: `HTTP ${res.status}`,
        debug,
      };
    }

    // Short page + Cloudflare challenge interstitial only — long HTML is real content (recipes on CF sites)
    if (
      html.length < MIN_HTML_TO_TRUST_CONTENT &&
      looksLikeCloudflareChallengeOnly(html)
    ) {
      debug.preview = html.slice(0, 500);
      logDebug(url, html, debug);
      return {
        ok: false,
        raw_text: "",
        confidence: "low",
        error: "Cloudflare challenge page (try again or use another link)",
        debug,
      };
    }

    const jsonLd = extractJsonLdRecipeFromHtml(html);
    if (jsonLd && jsonLd.length > 80) {
      debug.jsonLdFound = true;
      debug.cleanedLength = jsonLd.length;
      debug.preview = jsonLd.slice(0, 500);
      logDebug(url, html, debug);
      return {
        ok: true,
        raw_text: jsonLd.slice(0, 50000),
        confidence: "high",
        debug,
      };
    }

    const readText = readabilityText(html, url);
    const sectionText = extractRecipeSections(html);
    const $ = stripNoiseWithCheerio(html);
    const mainSel = $(
      "main, article, [role='main'], .entry-content, .post-content, .recipe-card, #recipe"
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
    debug.cleanedLength = combined.length;
    debug.preview = combined.slice(0, 500);
    logDebug(url, html, debug);

    if (combined.length < 50) {
      return {
        ok: false,
        raw_text: "",
        confidence: "low",
        error: "Could not extract enough text from this page",
        debug,
      };
    }

    return {
      ok: true,
      raw_text: combined,
      confidence: readText.length > 500 ? "high" : "medium",
      debug,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Fetch failed";
    debug.preview = html.slice(0, 500);
    logDebug(url, html, debug);
    return {
      ok: false,
      raw_text: "",
      confidence: "low",
      error: msg,
      debug,
    };
  }
}
