# Recipe Cloud as an evolving recipe workspace

## Mental model

**Not:** “I’m saving isolated recipes.”  
**Yes:** “I’m building *my* version of this dish over time.”

The first save is a **strong first version**, not a final truth. The **recipe page** is the **home base** where everything accumulates: ingredients, steps, quality notes, sources, and history.

---

## Roles

| Surface | Role |
|---------|------|
| **Web `/create`** | **Start** — multiple links or screenshots → one coherent first recipe. |
| **Recipe page** | **Read · scale · cook** — core vs optional, substitutions, steps, must-know / avoid, variants, history. |
| **Chrome extension** | **Refine** — “I found a better tip / shortcut / flavor note → add it to *this* tiramisu.” |

---

## Extension behavior

User flow: open blog / YouTube / reel → extension → **add to current recipe** | **another recent recipe** | **create new**.

After adding a source: full re-synthesis over all `raw_texts[]` → **review** (apply / keep source / discard) → **Recipe updated** moment with a **material summary** (what changed, whether it helps, whether the source is worth keeping).

---

## What strong vs weak sources should do

| Source strength | Influences |
|-----------------|------------|
| **Strong** | Core ingredients, main step flow, dish identity |
| **Medium** | Optional lines, substitutions, step wording, timing |
| **Weak (e.g. reels)** | Tips, warnings, variants, optional ideas — **rarely** a full rewrite |

---

## Good outputs (checklist)

- **One coherent recipe**, not merged note dumps.  
- **Core** = identity; **optional** = enhancements / style; **substitutions** = role-preserving swaps.  
- **Steps**: family-aware order, preheat / chill / bowl assembly when relevant, no fake section-title steps.  
- **Must know / Avoid**: high-value only — failure prevention, authenticity, texture/timing.  
- **Suggestions** = substitution, style, execution, or flavor — not random AI chatter.

---

## When little changes after a new source

That’s valid. The UI should communicate e.g. **“Source merged in; your best version shifted only slightly — check Must know / Avoid and Variants.”**

---

## Success loop (example)

1. **Day 1** — Three blog/YouTube sources on web → one clean tiramisu.  
2. **Day 2** — Reel: “don’t oversoak ladyfingers” → extension → apply → new **Avoid**, maybe a sharper step.  
3. **Day 3** — Whipped-cream variant source → variant note + optional, classic core stable.

This loop is the product moat: **web = start · extension = collect intelligence · recipe page = cook from the latest best version.**
