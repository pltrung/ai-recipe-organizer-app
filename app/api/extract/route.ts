import { NextRequest, NextResponse } from "next/server";
import { detectPlatform } from "@/lib/platformDetector";
import { fetchContent } from "@/lib/fetchContent";
import { extractRecipe } from "@/lib/aiExtractor";

export async function POST(req: NextRequest) {
  try {
    const { url } = (await req.json()) as { url: string };
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "Missing url" }, { status: 400 });
    }
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return NextResponse.json({ error: "OpenAI not configured" }, { status: 500 });
    }
    const platform = detectPlatform(url);
    const rawText = await fetchContent(url, platform);
    const recipe = await extractRecipe(rawText, key);
    if (!recipe.ingredients.length && !recipe.steps.length) {
      return NextResponse.json(
        { error: "No recipe content extracted" },
        { status: 422 }
      );
    }
    return NextResponse.json({ platform, recipe });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
