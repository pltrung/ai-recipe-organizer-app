import type { LinkClassification, Platform } from "./types";

const PLATFORM_PATTERNS: { pattern: RegExp; platform: Platform }[] = [
  { pattern: /(youtube\.com|youtu\.be)/i, platform: "youtube" },
  { pattern: /tiktok\.com/i, platform: "tiktok" },
  { pattern: /instagram\.com/i, platform: "instagram" },
  { pattern: /(facebook\.com|fb\.com|fb\.watch)/i, platform: "facebook" },
  { pattern: /(xiaohongshu\.com|xhslink\.com)/i, platform: "xiaohongshu" },
];

export function classifyLink(url: string): LinkClassification {
  const u = url.trim();
  for (const { pattern, platform } of PLATFORM_PATTERNS) {
    if (pattern.test(u)) {
      if (platform === "youtube") {
        if (/\/shorts\//i.test(u))
          return { platform: "youtube", type: "short", strategy: "youtube" };
        if (/\/watch/i.test(u) || /youtu\.be\//i.test(u))
          return { platform: "youtube", type: "video", strategy: "youtube" };
        return { platform: "youtube", type: "video", strategy: "youtube" };
      }
      if (
        platform === "instagram" ||
        platform === "facebook" ||
        platform === "tiktok" ||
        platform === "xiaohongshu"
      ) {
        const isReel =
          /\/reel\//i.test(u) ||
          /\/reels\//i.test(u) ||
          /\/shorts\//i.test(u) ||
          /\/videos?\//i.test(u);
        return {
          platform,
          type: isReel ? "reel" : "post",
          strategy: "reel_fallback",
        };
      }
    }
  }
  return { platform: "website", type: "page", strategy: "html_parse" };
}
