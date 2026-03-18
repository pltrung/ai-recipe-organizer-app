/**
 * Lightweight checks for merge review flow (run: npx tsx scripts/merge-review-check.ts)
 * Manual QA: see docs/MERGE_REVIEW_FLOW.md
 */
import { parsePendingMerge } from "../lib/mergePending";

console.assert(parsePendingMerge(null) === null);
console.assert(parsePendingMerge({}) === null);
console.assert(
  parsePendingMerge({
    version: 1,
    created_at: "x",
    synth_ok: true,
    source_summary: { source_url: "", source_type: "web", confidence: "high" },
    next_source_urls: [],
    next_source_platforms: [],
    next_sources: [],
    next_raw_texts: [],
    combined_text: "",
    source_extractions: null,
    diff: { summary: "", key_improvements: [] },
    last_diff: null,
    version_entry_apply: null,
    row_update: null,
  }) !== null
);
console.log("merge-review-check: ok");
