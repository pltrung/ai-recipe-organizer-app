import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import {
  EXTENSION_CORS_HEADERS,
  withExtensionCors,
} from "@/lib/extensionCors";

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: EXTENSION_CORS_HEADERS });
}

/**
 * List recent recipes (for Chrome extension recipe picker).
 * GET /api/recipes?limit=5
 */
export async function GET(req: NextRequest) {
  try {
    const limit = Math.min(
      50,
      Math.max(1, parseInt(req.nextUrl.searchParams.get("limit") || "5", 10))
    );
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("recipes")
      .select("id, title, source_urls, updated_at, created_at")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("GET /api/recipes:", error);
      return NextResponse.json(
        { error: "Failed to list recipes", recipes: [] },
        withExtensionCors({ status: 500 })
      );
    }

    const recipes = (data ?? []).map((r) => {
      const urls = Array.isArray(r.source_urls) ? r.source_urls : [];
      return {
        id: r.id,
        title: r.title || "Untitled",
        source_count: urls.length,
        updated_at: r.updated_at ?? r.created_at,
      };
    });

    return NextResponse.json(
      { recipes },
      { headers: EXTENSION_CORS_HEADERS }
    );
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Server error", recipes: [] },
      withExtensionCors({ status: 500 })
    );
  }
}
