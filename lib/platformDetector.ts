import type { Platform } from "./types";

const PATTERNS: { pattern: RegExp; platform: Platform }[] = [
  { pattern: /(youtube\.com|youtu\.be)/i, platform: "youtube" },
  { pattern: /tiktok\.com/i, platform: "tiktok" },
  { pattern: /instagram\.com/i, platform: "instagram" },
  { pattern: /(facebook\.com|fb\.com|fb\.watch)/i, platform: "facebook" },
  { pattern: /(xiaohongshu\.com|xhslink\.com)/i, platform: "xiaohongshu" },
];

export function detectPlatform(url: string): Platform {
  const trimmed = url.trim();
  for (const { pattern, platform } of PATTERNS) {
    if (pattern.test(trimmed)) return platform;
  }
  return "website";
}

export function isValidUrl(str: string): boolean {
  try {
    new URL(str.trim());
    return true;
  } catch {
    return false;
  }
}
