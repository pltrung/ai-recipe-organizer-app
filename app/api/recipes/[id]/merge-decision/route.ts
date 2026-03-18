import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabaseServer";
import {
  parsePendingMerge,
  emptyExtractionSlot,
} from "@/lib/mergePending";
import { recipeFromDbRow } from "@/lib/parseRecipeFromDb";
import { EXTENSION_CORS_HEADERS } from "@/lib/extensionCors";

function json(data: object, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...EXTENSION_CORS_HEADERS, ...(init?.headers as object) },
  });
}

function fullRecipeFromRow(row: Record<string, unknown>) {
  const r = recipeFromDbRow(row);
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    ingredients: r.ingredients,
    steps: r.steps,
    tips: r.tips,
    substitutions: r.substitutions,
    mistakes: r.mistakes,
    techniques: r.techniques,
    estimated_time: r.estimated_time,
    servings: r.servings,
    servings_base: r.servings_base,
    source_urls: r.source_urls,
    source_platforms: r.source_platforms,
    sources: r.sources ?? [],
    raw_texts: r.raw_texts ?? [],
    needs_user_input: Boolean(r.needs_user_input),
    needs_review: Boolean(r.needs_review),
    updated_at: row.updated_at ?? null,
    last_diff: r.last_diff ?? null,
    versions: r.versions ?? [],
    recipe_quality: r.recipe_quality ?? null,
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: EXTENSION_CORS_HEADERS });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: recipeId } = await params;
    if (!recipeId?.trim()) {
      return json({ error: "Missing recipe id" }, { status: 400 });
    }

    const body = (await req.json()) as { action?: string };
    const action = String(body?.action ?? "").toLowerCase().replace(/-/g, "_");

    const normalized =
      action === "keep_source_only" || action === "keep_source"
        ? "keep_source"
        : action;
    if (!["apply", "keep_source", "discard"].includes(normalized)) {
      return json(
        { error: "Invalid action. Use apply, keep_source, or discard." },
        { status: 400 }
      );
    }
    const act = normalized;

    const supabase = createServerClient();
    const { data: row, error: fetchErr } = await supabase
      .from("recipes")
      .select("*")
      .eq("id", recipeId)
      .single();

    if (fetchErr || !row) {
      return json({ error: "Recipe not found" }, { status: 404 });
    }

    const rec = row as Record<string, unknown>;
    const pending = parsePendingMerge(rec.pending_merge);

    if (!pending) {
      return json(
        { error: "No pending merge to resolve. Add a source again from the extension." },
        { status: 400 }
      );
    }

    if (act === "discard") {
      const { error: upErr } = await supabase
        .from("recipes")
        .update({ pending_merge: null })
        .eq("id", recipeId);

      if (upErr) {
        console.error("[merge-decision] discard:", upErr);
        return json({ error: "Failed to discard" }, { status: 500 });
      }

      const { data: fresh } = await supabase
        .from("recipes")
        .select("*")
        .eq("id", recipeId)
        .single();

      return json({
        ok: true,
        action: "discard",
        recipe: fresh ? fullRecipeFromRow(fresh as Record<string, unknown>) : null,
      });
    }

    const at = new Date().toISOString();
    const prevVer = Array.isArray(rec.versions) ? rec.versions : [];

    if (act === "keep_source") {
      let source_extractions: unknown = pending.source_extractions;
      if (!source_extractions || !Array.isArray(source_extractions)) {
        const prev = Array.isArray(rec.source_extractions)
          ? [...(rec.source_extractions as unknown[])]
          : [];
        const lastRaw =
          pending.next_raw_texts[pending.next_raw_texts.length - 1] ?? "";
        const label =
          pending.next_sources[pending.next_sources.length - 1] ?? "source";
        prev.push(
          emptyExtractionSlot(
            label,
            pending.source_summary.source_url,
            pending.source_summary.source_type,
            lastRaw
          )
        );
        source_extractions = prev;
      }

      const versionEntry = {
        at,
        source_count_after: pending.next_sources.length,
        summary: pending.synth_ok
          ? "Source added — recipe body left unchanged."
          : "Source added for reference. Re-synthesis can be run from the app when ready.",
        key_improvements: [
          pending.synth_ok
            ? "New page is in your source history. Open the recipe to apply a merged version later if you want."
            : "Weak capture: recipe unchanged; try a fuller page or blog next time.",
        ],
      };

      const { error: upErr } = await supabase
        .from("recipes")
        .update({
          source_urls: pending.next_source_urls,
          source_platforms: pending.next_source_platforms,
          sources: pending.next_sources,
          raw_texts: pending.next_raw_texts,
          raw_text: pending.combined_text || null,
          source_extractions,
          versions: [versionEntry, ...prevVer].slice(0, 10),
          pending_merge: null,
          needs_review: false,
          updated_at: at,
        })
        .eq("id", recipeId);

      if (upErr) {
        console.error("[merge-decision] keep_source:", upErr);
        return json({ error: "Failed to save source" }, { status: 500 });
      }

      const { data: fresh } = await supabase
        .from("recipes")
        .select("*")
        .eq("id", recipeId)
        .single();

      console.log(`[merge-decision] keep_source id=${recipeId} sources=${pending.next_sources.length}`);

      return json({
        ok: true,
        action: "keep_source",
        sourceCount: pending.next_sources.length,
        recipe: fresh ? fullRecipeFromRow(fresh as Record<string, unknown>) : null,
      });
    }

    /* apply */
    if (!pending.synth_ok || !pending.row_update) {
      return json(
        {
          error:
            "There is no AI-proposed recipe to apply. Use “Keep source only” or “Discard”.",
        },
        { status: 400 }
      );
    }

    const ru = pending.row_update;
    const versions = [pending.version_entry_apply, ...prevVer].slice(0, 10);

    const { error: upErr } = await supabase
      .from("recipes")
      .update({
        title: ru.title,
        description: ru.description,
        ingredients: ru.ingredients,
        steps: ru.steps,
        tips: ru.tips,
        substitutions: ru.substitutions,
        mistakes: ru.mistakes,
        techniques: ru.techniques,
        estimated_time: ru.estimated_time,
        servings: ru.servings,
        servings_base: ru.servings_base,
        recipe_quality: ru.recipe_quality,
        needs_user_input: ru.needs_user_input,
        source_urls: pending.next_source_urls,
        source_platforms: pending.next_source_platforms,
        sources: pending.next_sources,
        raw_texts: pending.next_raw_texts,
        raw_text: pending.combined_text || null,
        source_extractions: pending.source_extractions,
        last_diff: pending.last_diff,
        versions,
        pending_merge: null,
        needs_review: false,
        updated_at: pending.last_diff?.at || at,
      })
      .eq("id", recipeId);

    if (upErr) {
      console.error("[merge-decision] apply:", upErr);
      return json({ error: "Failed to apply update" }, { status: 500 });
    }

    const { data: fresh } = await supabase
      .from("recipes")
      .select("*")
      .eq("id", recipeId)
      .single();

    console.log(
      `[merge-decision] apply id=${recipeId} sources=${pending.next_sources.length}`
    );

    return json({
      ok: true,
      action: "apply",
      sourceCount: pending.next_sources.length,
      last_diff: pending.last_diff,
      recipe: fresh ? fullRecipeFromRow(fresh as Record<string, unknown>) : null,
    });
  } catch (e) {
    console.error("[merge-decision]", e);
    return json({ error: "Server error" }, { status: 500 });
  }
}
