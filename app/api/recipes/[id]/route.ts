import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import { EXTENSION_CORS_HEADERS } from "@/lib/extensionCors";

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: EXTENSION_CORS_HEADERS });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json(
        { error: "Invalid id" },
        { status: 400, headers: EXTENSION_CORS_HEADERS }
      );
    }
    const supabase = createServerClient();
    const { error } = await supabase.from("recipes").delete().eq("id", id);
    if (error) {
      console.error("DELETE recipe:", error);
      return NextResponse.json(
        { error: "Failed to delete" },
        { status: 500, headers: EXTENSION_CORS_HEADERS }
      );
    }
    return NextResponse.json({ ok: true }, { headers: EXTENSION_CORS_HEADERS });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Server error" },
      { status: 500, headers: EXTENSION_CORS_HEADERS }
    );
  }
}
