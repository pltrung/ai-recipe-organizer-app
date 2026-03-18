import type { Confidence, ExtractionResult } from "./types";
import { extractWebsite } from "./websiteExtract";

const FETCH_OPTS = {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  },
  signal: AbortSignal.timeout(20000),
};

/**
 * A. HTML_PARSE — JSON-LD, Readability, cheerio sections (see websiteExtract).
 */
export async function strategyHtmlParse(url: string): Promise<ExtractionResult | null> {
  const w = await extractWebsite(url);
  if (!w.ok) return null;
  return {
    raw_text: w.raw_text,
    confidence: w.confidence,
    source_label: "Blog / webpage",
  };
}

export function extractYouTubeVideoId(url: string): string | null {
  const u = url.trim();
  const m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  return m ? m[1] : null;
}

/**
 * B. YOUTUBE — Medium confidence. Transcript first, then title + description.
 */
export async function strategyYoutube(url: string): Promise<ExtractionResult | null> {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) return null;

  let raw_text = "";
  let confidence: Confidence = "medium";

  try {
    const { fetchTranscript } = await import("youtube-transcript");
    const transcript = await fetchTranscript(videoId);
    const list = Array.isArray(transcript) ? transcript : [];
    if (list.length > 0) {
      raw_text = list.map((t: { text?: string }) => t?.text ?? "").join(" ");
      if (raw_text.length > 100) {
        raw_text = `[Video transcript]\n${raw_text}`;
        confidence = "medium";
      }
    }
  } catch {
    /* transcript not available */
  }

  if (!raw_text || raw_text.length < 80) {
    try {
      const res = await fetch(url, FETCH_OPTS);
      if (res.ok) {
        const html = await res.text();
        const desc = extractShortDescription(html);
        const meta = extractMetaDescription(html);
        const title = extractYouTubeTitle(html);
        const parts = [title, desc || meta].filter(Boolean);
        if (parts.length > 0) {
          raw_text = parts.join("\n\n");
          if (raw_text.length < 50) raw_text = "";
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!raw_text || raw_text.length < 30) {
    return {
      raw_text:
        "This is a cooking video. The exact transcript or description could not be retrieved. Infer a likely recipe from the video title or common cooking patterns if possible.",
      confidence: "low",
      source_label: "YouTube video",
    };
  }
  return { raw_text, confidence, source_label: "YouTube video" };
}

function extractShortDescription(html: string): string | null {
  const m = html.match(/"shortDescription":\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  return m[1]
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim();
}

function extractMetaDescription(html: string): string | null {
  const m = html.match(
    /<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)["']/i
  );
  if (m) return m[1].replace(/&amp;/g, "&").trim();
  const m2 = html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:description|description)["']/i
  );
  return m2 ? m2[1].replace(/&amp;/g, "&").trim() : null;
}

function extractYouTubeTitle(html: string): string | null {
  const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (m) return m[1].replace(/&amp;/g, "&").trim();
  const m2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  return m2 ? m2[1].replace(/&amp;/g, "&").trim() : null;
}

/**
 * C. REEL_FALLBACK — Low confidence. Placeholder for short-form video.
 */
export function strategyReelFallback(platform: string): ExtractionResult {
  return {
    raw_text: `This is a short-form cooking video from ${platform}.

The exact transcript is unavailable.

Infer a likely recipe based on common cooking patterns, typical ingredients and steps for similar dishes, and any hints in the source. If you cannot infer a specific recipe, provide a minimal placeholder recipe (e.g. "Recipe from short video – edit to complete") so the user can fill in details.`,
    confidence: "low",
    source_label: `${platform} reel/video`,
  };
}

/**
 * D. IMAGE_EXTRACTION — Medium/High. OpenAI Vision to extract recipe from screenshot.
 */
export async function strategyImage(
  imageBase64: string,
  openaiApiKey: string
): Promise<ExtractionResult | null> {
  try {
    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const base64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a recipe extractor. From the image (screenshot of a recipe, blog, or social post), extract:
- title
- description (if any)
- ingredients (list each item)
- steps (numbered instructions)
If the image is not a recipe, describe what you see and suggest a possible dish name. Output as plain text in this format:
Title: ...
Description: ...
Ingredients:
- ...
Steps:
1. ...
Always return something usable.`,
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64}` },
            },
          ],
        },
      ],
      max_tokens: 1500,
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) return null;
    const confidence: Confidence = content.length > 200 ? "high" : "medium";
    return { raw_text: content, confidence, source_label: "Image / screenshot" };
  } catch {
    return null;
  }
}
