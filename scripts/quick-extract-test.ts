/**
 * Run: npx tsx scripts/quick-extract-test.ts
 * Requires OPENAI_API_KEY for AI step; website extract works without it.
 */
import { extractWebsite } from "../lib/websiteExtract";
import { extractRecipe } from "../lib/aiExtractor";

const URLS = [
  "https://pupswithchopsticks.com/bun-bo-hue/",
  "https://www.cooking-therapy.com/bun-bo-hue/",
];

async function main() {
  const key = process.env.OPENAI_API_KEY || "";
  for (const url of URLS) {
    console.log("\n===", url, "===");
    const w = await extractWebsite(url);
    console.log("website ok:", w.ok, "raw_len:", w.raw_text.length);
    if (!w.ok) {
      console.log("error:", w.error);
      continue;
    }
    console.log("raw preview:", w.raw_text.slice(0, 200).replace(/\s+/g, " "));
    if (key) {
      const r = await extractRecipe(w.raw_text, key);
      console.log(
        "AI → ingredients:",
        r.ingredients.length,
        "steps:",
        r.steps.length
      );
    } else {
      console.log("(skip AI — set OPENAI_API_KEY)");
    }
  }
}

main().catch(console.error);
