# Extension merge review (user-controlled)

Product context: **`docs/RECIPE_WORKSPACE.md`** — extension = refine / collect intelligence; recipe page = home base.

## Flow

1. User adds a page to an **existing** recipe from the Chrome extension.
2. **POST `/api/extract-from-extension`** runs full re-synthesis (existing `raw_texts[]` + new source) but **does not** overwrite the recipe body. It stores a **`pending_merge`** JSON on the row and returns **`reviewRequired: true`** with a **proposal** (diff summary + source summary).
3. Extension shows **Apply changes** / **Keep source only** / **Discard**.
4. **POST `/api/recipes/[id]/merge-decision`** with `{ "action": "apply" | "keep_source" | "discard" }` commits the chosen outcome.

## DB

- **`recipes.pending_merge`** (JSONB, nullable) — proposal payload (`lib/mergePending.ts` shape).
- Run migration: `20250327000000_pending_merge.sql`.

## Scenarios (manual QA)

| # | Action | Expected |
|---|--------|----------|
| 1 | **Apply** after good synthesis | Body + `sources`/`raw_texts`/`source_extractions` update; `last_diff` + `versions` prepend; `pending_merge` cleared. |
| 2 | **Keep source only** | Append history only; body unchanged; version note “Source added…”. |
| 3 | **Discard** | Row unchanged; no new source; `pending_merge` cleared. |
| 4 | Weak reel + synth fail | Apply disabled; Keep / Discard still work. |
| 5 | After Apply, open `/recipe/[id]?updated=…` | Fresh row (`noStore`); new source count and **Recently improved** if `last_diff` set. |

## API

| Endpoint | Body | Result |
|----------|------|--------|
| `POST /api/extract-from-extension` | merge payload | `reviewRequired`, `proposal`, `synthOk` |
| `POST /api/recipes/[id]/merge-decision` | `{ action }` | `apply` / `keep_source` / `discard` |

## Note

If a second merge is started before resolving the first, **`pending_merge` is overwritten** by the newer preview.
