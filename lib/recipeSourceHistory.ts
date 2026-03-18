/** Align stored sources[] with raw_texts[]; backfill legacy single raw_text blob. */

export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}

export function parseJsonStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? ""));
}

/**
 * Load parallel sources + raw_texts from row (handles legacy rows with only raw_text).
 */
export function hydrateRecipeSourceHistory(row: Record<string, unknown>): {
  sources: string[];
  raw_texts: string[];
} {
  let sources = parseJsonStringArray(row.sources).map((s) => s.trim());
  let raw_texts = parseJsonStringArray(row.raw_texts);

  if (raw_texts.length === 0 && row.raw_text != null) {
    const blob = String(row.raw_text);
    if (blob.trim()) raw_texts = [blob];
  }

  const urls = asStringArray(row.source_urls);
  while (sources.length < raw_texts.length) {
    const i = sources.length;
    sources.push((urls[i] ?? urls[urls.length - 1] ?? "unknown").trim() || "unknown");
  }
  while (raw_texts.length < sources.length) {
    raw_texts.push("");
  }

  return { sources, raw_texts };
}

export const RAW_TEXT_JOINER = "\n\n---\n\n";
