import type { Platform } from "./types";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const FETCH_OPTS = {
  headers: BROWSER_HEADERS,
  signal: AbortSignal.timeout(20000),
};

/**
 * Fetch content from a URL with platform-specific extraction.
 * Pass platform so we can use the right strategy (blog vs YouTube vs social).
 */
export async function fetchContent(
  url: string,
  platform?: Platform
): Promise<string> {
  try {
    const res = await fetch(url, FETCH_OPTS);
    if (!res.ok) return `[Could not load: ${res.status}]`;
    const html = await res.text();

    if (platform === "youtube") {
      const desc = extractYouTubeDescription(html);
      if (desc && desc.length > 50) return desc;
      const metaDesc = extractMetaDescription(html);
      if (metaDesc && metaDesc.length > 30) return metaDesc;
      return "[YouTube: Video description could not be read. Paste the recipe or description in 'Help us complete this recipe' if the link doesn't work.]";
    }

    if (
      platform === "facebook" ||
      platform === "instagram" ||
      platform === "tiktok"
    ) {
      const text = extractVisibleText(html);
      const hasContent =
        text.length > 300 &&
        !/log in|sign up|login|facebook\.com|instagram\.com|tiktok\.com/i.test(
          text.slice(0, 500)
        );
      if (hasContent) return text;
      return `[${platform}: This app can't read content from this link yet. Use "Help us complete this recipe" after creating to paste the recipe yourself.]`;
    }

    // website (blogs, etc.): try JSON-LD recipe first, then main text
    const jsonLd = extractJsonLdRecipe(html);
    if (jsonLd) return jsonLd;
    return extractVisibleText(html);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return `[Fetch failed: ${message}]`;
  }
}

function extractVisibleText(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
  text = text
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/g, " ")
    .trim();
  return text.slice(0, 50000);
}

function extractMetaDescription(html: string): string | null {
  const match = html.match(
    /<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)["']/i
  );
  if (match) return decodeHtmlEntities(match[1]);
  const match2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:description|description)["']/i);
  if (match2) return decodeHtmlEntities(match2[1]);
  return null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Many recipe blogs (e.g. Hungry Huy) use JSON-LD Recipe schema.
 * Extract it so the AI gets structured content.
 */
function extractJsonLdRecipe(html: string): string | null {
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
      // skip invalid JSON
    }
  }
  return null;
}

/**
 * YouTube watch pages embed video description in ytInitialPlayerResponse
 * or ytInitialData. Extract so we can send to the AI.
 */
function extractYouTubeDescription(html: string): string | null {
  // shortDescription in player response (often in a script)
  const shortDescMatch = html.match(
    /"shortDescription":\s*"((?:[^"\\]|\\.)*)"/
  );
  if (shortDescMatch) {
    const raw = shortDescMatch[1]
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    if (raw.length > 20) return raw;
  }
  return null;
}
