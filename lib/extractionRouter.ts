import { classifyLink } from "./classifyLink";
import {
  strategyHtmlParse,
  strategyYoutube,
  strategyReelFallback,
  strategyImage,
} from "./extractionStrategies";
import type { ExtractionResult, InputType } from "./types";

export type RouterInput =
  | { type: "url"; value: string }
  | { type: "image"; value: string }; // base64

/**
 * STEP 1 — Input detection (caller can pass type; otherwise we infer).
 * STEP 2–3 — Link classification + extraction router.
 * Returns one ExtractionResult per input. Never throws; returns null on hard failure.
 */
export async function fetchContent(
  input: RouterInput,
  openaiApiKey?: string
): Promise<ExtractionResult | null> {
  if (input.type === "image") {
    if (!openaiApiKey) return null;
    return strategyImage(input.value, openaiApiKey);
  }

  const url = input.value.trim();
  if (!url) return null;

  const { platform, strategy } = classifyLink(url);

  switch (strategy) {
    case "html_parse": {
      return strategyHtmlParse(url);
    }
    case "youtube": {
      return strategyYoutube(url);
    }
    case "reel_fallback": {
      return Promise.resolve(strategyReelFallback(platform));
    }
    default:
      return strategyHtmlParse(url);
  }
}

/** Detect input type from a string (url) or base64 data URI. */
export function detectInputType(value: string): InputType {
  const trimmed = value.trim();
  if (/^data:image\/\w+;base64,/.test(trimmed)) return "image";
  if (/^https?:\/\//i.test(trimmed)) return "url";
  return "url";
}
