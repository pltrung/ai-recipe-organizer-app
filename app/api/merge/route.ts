import { NextRequest, NextResponse } from "next/server";
import { mergeRecipes } from "@/lib/aiMerge";
import type { ExtractedRecipe } from "@/lib/types";

export async function POST(req: NextRequest) {
  try {
    const { recipes } = (await req.json()) as { recipes: ExtractedRecipe[] };
    if (!Array.isArray(recipes) || recipes.length === 0) {
      return NextResponse.json({ error: "Missing or empty recipes" }, { status: 400 });
    }
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return NextResponse.json({ error: "OpenAI not configured" }, { status: 500 });
    }
    const merged = await mergeRecipes(recipes, key);
    if (!merged) {
      return NextResponse.json({ error: "Merge failed" }, { status: 422 });
    }
    return NextResponse.json(merged);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
