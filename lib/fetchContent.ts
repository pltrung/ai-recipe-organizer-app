/**
 * MVP: Fetch HTML and extract visible text.
 * Future: platform-specific scrapers, oEmbed, etc.
 */
export async function fetchContent(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; RecipeCloud/1.0; +https://recipecloud.app)",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return `[Could not load: ${res.status}]`;
    const html = await res.text();
    return extractVisibleText(html);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return `[Fetch failed: ${message}]`;
  }
}

function extractVisibleText(html: string): string {
  // Strip script/style and simple tag removal for MVP
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
  text = text
    .replace(/\s+/g, " ")
    .replace(/&nbsp;/g, " ")
    .trim();
  return text.slice(0, 50000); // cap size for AI
}
