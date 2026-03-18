/**
 * Dynamic playbook compiler: composes cooking guidance from primitives,
 * dish-family skeletons, cuisine lenses, and source-derived anchors (AI).
 */

export const COOKING_PRIMITIVES: Record<string, string> = {
  simmer_broth: "Long simmer to extract flavor; skim; clarify if needed",
  build_dough: "Mix, knead, rest, shape; control hydration and gluten",
  marinate: "Time + acid/salt/enzyme for flavor and texture",
  stir_fry: "High heat, staged addition, sauce finish",
  braise: "Sear, liquid cover, low heat until tender",
  roast_bake: "Dry or moist heat in oven; doneness and color",
  layer_chilled_dessert: "Components separately, layer, set/chill",
  assemble_bowl: "Base + protein + broth/sauce + toppings in layers",
  make_sauce: "Reduce, emulsify, or raw blend; balance fat/acid/salt",
  garnish_finish: "Fresh herbs, acid, texture, temperature at service",
};

export const DISH_FAMILIES = [
  "noodle_soup",
  "braise_stew",
  "stir_fry",
  "layered_chilled_dessert",
  "baked_cake",
  "pizza_flatbread",
  "pasta",
  "salad_no_cook",
  "sauce_condiment",
  "rice_plate",
  "wrap_roll",
  "other",
] as const;

export type DishFamily = (typeof DISH_FAMILIES)[number];

export type FamilySkeleton = {
  expected_flow: string[];
  common_tools: string[];
  max_steps: number;
  min_steps: number;
  timing_structure: string[];
};

export const FAMILY_SKELETONS: Record<DishFamily, FamilySkeleton> = {
  noodle_soup: {
    expected_flow: [
      "Build or simmer broth base (aromatics, bones, spices as appropriate)",
      "Strain or clarify broth if needed; adjust depth",
      "Cook proteins and noodles separately or in stages",
      "Season broth; balance salt, acid, sweetness",
      "Assemble bowls: noodles, toppings, hot broth",
      "Finish with herbs, lime, chili oil, or regional garnishes",
    ],
    common_tools: ["large pot", "strainer", "ladle", "tongs"],
    max_steps: 10,
    min_steps: 5,
    timing_structure: [
      "Broth: often 45–180 min simmer (or quick version)",
      "Noodles: brief cook",
      "Assembly: immediate before eating",
    ],
  },
  braise_stew: {
    expected_flow: [
      "Season main protein or veg",
      "Sear for color and fond",
      "Sweat aromatics; deglaze",
      "Add liquid; submerge partially; gentle simmer",
      "Cook until tender; reduce or thicken sauce",
      "Rest if meat; adjust seasoning; serve",
    ],
    common_tools: ["Dutch oven or heavy pot", "wooden spoon"],
    max_steps: 9,
    min_steps: 5,
    timing_structure: [
      "Sear: short",
      "Braise: 1–4+ hours depending on cut",
    ],
  },
  stir_fry: {
    expected_flow: [
      "Prep all ingredients (mise en place); mix sauce if any",
      "High heat; cook aromatics",
      "Protein first; remove or push aside",
      "Vegetables by cook time",
      "Combine; sauce; toss; serve immediately",
    ],
    common_tools: ["wok or large skillet", "spatula"],
    max_steps: 8,
    min_steps: 4,
    timing_structure: ["Total active: often 10–20 min"],
  },
  layered_chilled_dessert: {
    expected_flow: [
      "Prepare bases (soak if needed)",
      "Make creams, custards, or fillings",
      "Layer in vessel; chill between layers if needed",
      "Final chill until set",
      "Garnish; unmold if applicable",
    ],
    common_tools: ["mixing bowls", "whisk", "springform or dish"],
    max_steps: 9,
    min_steps: 4,
    timing_structure: ["Chill: often 2–24 hours"],
  },
  baked_cake: {
    expected_flow: [
      "Preheat oven; prep pans",
      "Mix dry; mix wet; combine gently",
      "Bake to doneness",
      "Cool; frost or finish",
    ],
    common_tools: ["mixer", "pans", "oven", "rack"],
    max_steps: 8,
    min_steps: 5,
    timing_structure: ["Bake: 20–50 min typical", "Cool before frosting"],
  },
  pizza_flatbread: {
    expected_flow: [
      "Dough: mix, knead, ferment if time allows",
      "Shape base; sauce sparingly",
      "Cheese and toppings; high-heat bake",
      "Finish with fresh herbs or oil",
    ],
    common_tools: ["pizza stone or steel", "peel optional"],
    max_steps: 7,
    min_steps: 4,
    timing_structure: ["Bake: very high heat, short time"],
  },
  pasta: {
    expected_flow: [
      "Salted boiling water for pasta",
      "Sauce in parallel (or finish in pan with pasta water)",
      "Undercook pasta slightly; finish in sauce",
      "Emulsify; cheese; serve",
    ],
    common_tools: ["large pot", "sauté pan", "tongs"],
    max_steps: 7,
    min_steps: 4,
    timing_structure: ["Pasta: al dente timing critical"],
  },
  salad_no_cook: {
    expected_flow: [
      "Wash and dry greens/base",
      "Prep vegetables, fruits, proteins",
      "Dressing: emulsify or shake",
      "Toss or layer; serve fresh",
    ],
    common_tools: ["bowl", "salad spinner optional"],
    max_steps: 6,
    min_steps: 3,
    timing_structure: ["Serve immediately after dressing"],
  },
  sauce_condiment: {
    expected_flow: [
      "Cook or blend base ingredients",
      "Reduce or thicken; balance",
      "Strain or smooth; cool or hold hot",
      "Jar or serve",
    ],
    common_tools: ["saucepan", "blender optional"],
    max_steps: 6,
    min_steps: 3,
    timing_structure: ["Reduce time varies widely"],
  },
  rice_plate: {
    expected_flow: [
      "Rinse or toast rice if style requires",
      "Cook rice (absorption or pilaf)",
      "Prepare protein and sides in parallel",
      "Plate rice; top or side components; sauce",
    ],
    common_tools: ["rice cooker or pot", "pan for protein"],
    max_steps: 8,
    min_steps: 4,
    timing_structure: ["Rice rest after cook"],
  },
  wrap_roll: {
    expected_flow: [
      "Prep fillings (cooked or fresh)",
      "Soften wrappers if needed",
      "Roll or wrap tightly",
      "Slice or serve whole; dipping sauce",
    ],
    common_tools: ["cutting board", "damp towel for wrappers"],
    max_steps: 6,
    min_steps: 3,
    timing_structure: ["Serve fresh for crisp wrappers"],
  },
  other: {
    expected_flow: [
      "Mise en place",
      "Main cooking technique in logical order",
      "Season and adjust",
      "Rest if needed; plate and serve",
    ],
    common_tools: ["chef's knife", "cutting board", "primary pan/pot"],
    max_steps: 10,
    min_steps: 4,
    timing_structure: ["Varies by dish"],
  },
};

export type CuisineLens = {
  label: string;
  emphasis: string[];
  ingredient_bias: string[];
  serving_bias: string[];
};

export const CUISINE_LENSES: Record<string, CuisineLens> = {
  vietnamese: {
    label: "Vietnamese",
    emphasis: [
      "Broth clarity and depth; charred aromatics when traditional",
      "Fish sauce, sugar, lime balance",
      "Fresh herbs and bean sprouts at the table",
    ],
    ingredient_bias: ["nuoc mam", "lemongrass", "Thai basil", "perilla"],
    serving_bias: ["bowl assembly", "herb plate", "lime wedges"],
  },
  italian: {
    label: "Italian",
    emphasis: [
      "Few ingredients, each quality",
      "Dough fermentation when baking",
      "Sauce simplicity; pasta water for silkiness",
      "Finishing: olive oil, cheese, texture",
    ],
    ingredient_bias: ["EVOO", "Parmigiano", "tomato", "00 flour"],
    serving_bias: ["family style or individual plates", "warm service"],
  },
  japanese: {
    label: "Japanese",
    emphasis: ["dashi clarity", "knife cuts", "timing and temperature"],
    ingredient_bias: ["miso", "soy", "mirin", "dashi"],
    serving_bias: ["minimal garnish", "bowl aesthetics"],
  },
  thai: {
    label: "Thai",
    emphasis: ["sweet/sour/salty/spicy balance", "curry paste building"],
    ingredient_bias: ["fish sauce", "palm sugar", "lime", "Thai basil"],
    serving_bias: ["rice alongside", "condiments"],
  },
  chinese: {
    label: "Chinese",
    emphasis: ["wok hei when stir-frying", "layered textures"],
    ingredient_bias: ["soy", "Shaoxing", "ginger", "scallion"],
    serving_bias: ["shared plates", "rice last"],
  },
  mexican: {
    label: "Mexican",
    emphasis: ["chiles depth", "masa when relevant", "fresh vs cooked salsas"],
    ingredient_bias: ["lime", "cilantro", "onion", "chiles"],
    serving_bias: ["toppings bar", "warm tortillas"],
  },
  french: {
    label: "French",
    emphasis: ["sauce building", "butter reduction", "resting meat"],
    ingredient_bias: ["wine", "shallot", "herbs de Provence"],
    serving_bias: ["composed plates"],
  },
  indian: {
    label: "Indian",
    emphasis: ["toasting spices", "layering masala", "fat choice (ghee/oil)"],
    ingredient_bias: ["garam masala", "turmeric", "ginger-garlic"],
    serving_bias: ["rice or bread", "pickles/chutney"],
  },
  korean: {
    label: "Korean",
    emphasis: ["fermented depth", "gochugaru heat", "banchan balance"],
    ingredient_bias: ["gochujang", "sesame", "scallion"],
    serving_bias: ["many small sides", "rice bowl"],
  },
  mediterranean: {
    label: "Mediterranean",
    emphasis: ["olive oil quality", "herbs", "grilled and fresh contrast"],
    ingredient_bias: ["lemon", "oregano", "tomato"],
    serving_bias: ["mezze style or simple plate"],
  },
  default: {
    label: "General",
    emphasis: ["balance salt/fat/acid", "proper doneness"],
    ingredient_bias: [],
    serving_bias: ["hot food hot", "rest proteins"],
  },
};

function normalizeCuisineKey(cuisine: string): string {
  const c = cuisine.toLowerCase();
  if (/viet/.test(c)) return "vietnamese";
  if (/ital/.test(c)) return "italian";
  if (/japan/.test(c)) return "japanese";
  if (/thai/.test(c)) return "thai";
  if (/china|sichuan|cantonese|mandarin/.test(c)) return "chinese";
  if (/mexic|tex-mex/.test(c)) return "mexican";
  if (/french/.test(c)) return "french";
  if (/india/.test(c)) return "indian";
  if (/korea/.test(c)) return "korean";
  if (/mediter/.test(c)) return "mediterranean";
  return "default";
}

export type DynamicPlaybook = {
  dish_family: string;
  cuisine: string;
  core_roles: string[];
  expected_flow: string[];
  key_techniques: string[];
  likely_tools: string[];
  timing_expectations: string[];
  failure_points: string[];
  serving_style: string[];
  /** Anchors inferred from sources (logged + optional UI) */
  signature_ingredients: string[];
  signature_techniques: string[];
  stepMin: number;
  stepMax: number;
};

function mergeUnique(a: string[], b: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of [...a, ...b]) {
    const t = x.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

function fallbackPlaybook(
  family: DishFamily,
  cuisineKey: string,
  dishName: string
): DynamicPlaybook {
  const sk = FAMILY_SKELETONS[family] ?? FAMILY_SKELETONS.other;
  const lens = CUISINE_LENSES[cuisineKey] ?? CUISINE_LENSES.default;
  const flow = [
    ...sk.expected_flow.slice(0, 2).map((s) => `[${family}] ${s}`),
    ...lens.emphasis.slice(0, 2).map((s) => `[${lens.label}] ${s}`),
    ...sk.expected_flow.slice(2),
  ];
  return {
    dish_family: family,
    cuisine: lens.label,
    core_roles: ["main protein or starch", "aromatic base", "liquid or sauce", "garnish"],
    expected_flow: flow,
    key_techniques: Object.keys(COOKING_PRIMITIVES).slice(0, 5),
    likely_tools: sk.common_tools,
    timing_expectations: sk.timing_structure,
    failure_points: [
      "Overcooking main protein",
      "Under-seasoning before serving",
      "Rushing rest or chill steps",
    ],
    serving_style: mergeUnique(sk.timing_structure, lens.serving_bias),
    signature_ingredients: [],
    signature_techniques: [],
    stepMin: sk.min_steps,
    stepMax: sk.max_steps,
  };
}

export type CompilePlaybookInput = {
  dishName: string;
  cuisine: string;
  ingredientCandidates: string[];
  stepCandidates: string[];
  tipCandidates: string[];
  confidenceSummary: string;
};

export async function compileDynamicPlaybook(
  openaiApiKey: string,
  input: CompilePlaybookInput
): Promise<DynamicPlaybook> {
  const cuisineKey = normalizeCuisineKey(input.cuisine || "");
  const lens = CUISINE_LENSES[cuisineKey] ?? CUISINE_LENSES.default;

  const familyRef = DISH_FAMILIES.join(", ");
  const primitivesBlock = Object.entries(COOKING_PRIMITIVES)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const skeletonRef = DISH_FAMILIES.filter((f) => f !== "other")
    .map((f) => {
      const s = FAMILY_SKELETONS[f as DishFamily];
      return `${f}: flow=${JSON.stringify(s.expected_flow.slice(0, 3))}… max_steps=${s.max_steps}`;
    })
    .join("\n");

  const lensRef = `${lens.label}: ${lens.emphasis.join(" | ")}`;

  const ingSample = input.ingredientCandidates.slice(0, 60).join("\n");
  const stepSample = input.stepCandidates.slice(0, 40).join("\n");
  const tipSample = input.tipCandidates.slice(0, 25).join("\n");

  const system = `You are a dynamic playbook compiler for recipe synthesis.

UNIVERSAL PRIMITIVES (reference; weave into techniques):
${primitivesBlock}

DISH FAMILIES (pick exactly one): ${familyRef}

FAMILY SKELETONS (use as base; expand with anchors):
${skeletonRef}

CUISINE LENS for this recipe (${lens.label}):
${lensRef}
Ingredient biases: ${lens.ingredient_bias.join(", ") || "—"}
Serving biases: ${lens.serving_bias.join(", ") || "—"}

TASK:
1. Choose dish_family from the enum.
2. Extract SIGNATURE ANCHORS from candidates: 3–8 signature_ingredients, 2–5 signature_techniques, 1–2 serving anchors.
3. COMPOSE expected_flow: start from that family's logical order, inject anchor-specific steps where needed, add 1–2 lens-specific beats (e.g. herb finish for Vietnamese).
4. core_roles: ingredient roles this dish type needs (e.g. broth, noodles, protein for noodle_soup).
5. key_techniques: which primitives apply most.
6. likely_tools: merge family tools + dish-specific.
7. timing_expectations: realistic bands.
8. failure_points: 3–6 dish-specific mistakes.
9. serving_style: how it hits the table.

Return STRICT JSON:
{
  "dish_family": string,
  "signature_ingredients": string[],
  "signature_techniques": string[],
  "core_roles": string[],
  "expected_flow": string[],
  "key_techniques": string[],
  "likely_tools": string[],
  "timing_expectations": string[],
  "failure_points": string[],
  "serving_style": string[]
}

expected_flow: 5–12 short imperative lines. Must reflect family + anchors + lens.`;

  const user = `DISH: ${input.dishName}
CUISINE HINT: ${input.cuisine || "unknown"}
SOURCE CONFIDENCE: ${input.confidenceSummary}

INGREDIENT CANDIDATES:
${ingSample || "(none)"}

STEP CANDIDATES:
${stepSample || "(none)"}

TIP CANDIDATES:
${tipSample || "(none)"}`;

  let family: DishFamily = "other";
  let out: DynamicPlaybook = fallbackPlaybook("other", cuisineKey, input.dishName);

  if (!openaiApiKey?.trim()) {
    console.log(
      "[dynamic-playbook] skip AI; fallback family=other cuisine=",
      lens.label
    );
    return out;
  }

  try {
    const OpenAI = (await import("openai")).default;
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user.slice(0, 24_000) },
      ],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    const p = JSON.parse(raw) as Record<string, unknown>;
    const df = String(p.dish_family ?? "").toLowerCase().replace(/\s+/g, "_");
    if (DISH_FAMILIES.includes(df as DishFamily)) {
      family = df as DishFamily;
    }

    const sk = FAMILY_SKELETONS[family] ?? FAMILY_SKELETONS.other;
    const take = (k: string, max: number) =>
      Array.isArray(p[k])
        ? (p[k] as unknown[]).map((x) => String(x).trim()).filter(Boolean).slice(0, max)
        : [];

    const expected_flow = take("expected_flow", 14);
    const sigIng = take("signature_ingredients", 10);
    const sigTech = take("signature_techniques", 6);

    out = {
      dish_family: family,
      cuisine: lens.label,
      core_roles: take("core_roles", 10),
      expected_flow:
        expected_flow.length >= 4
          ? expected_flow
          : fallbackPlaybook(family, cuisineKey, input.dishName).expected_flow,
      key_techniques: take("key_techniques", 12),
      likely_tools: mergeUnique(take("likely_tools", 14), sk.common_tools),
      timing_expectations: mergeUnique(
        take("timing_expectations", 8),
        sk.timing_structure
      ),
      failure_points: take("failure_points", 8),
      serving_style: mergeUnique(take("serving_style", 8), lens.serving_bias),
      signature_ingredients: sigIng,
      signature_techniques: sigTech,
      stepMin: sk.min_steps,
      stepMax: sk.max_steps,
    };

    const flowPreview = out.expected_flow.slice(0, 3).join(" → ");
    console.log(
      `[dynamic-playbook] family=${out.dish_family} cuisine_lens=${cuisineKey} anchors_ing=${sigIng.length} anchors_tech=${sigTech.length} flow_preview="${flowPreview.slice(0, 120)}…"`
    );
    console.log(
      `[dynamic-playbook] summary roles=${out.core_roles.length} tools=${out.likely_tools.length} failures=${out.failure_points.length} steps_band=${out.stepMin}-${out.stepMax}`
    );
  } catch (e) {
    console.error("[dynamic-playbook] AI compile failed, fallback:", e);
    out = fallbackPlaybook(
      family === "other" ? "other" : family,
      cuisineKey,
      input.dishName
    );
    out.signature_ingredients = input.ingredientCandidates.slice(0, 6);
  }

  return out;
}

export function playbookForPhaseC(playbook: DynamicPlaybook): string {
  const flow = playbook.expected_flow.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `DYNAMIC PLAYBOOK (judge ingredients against this — prefer playbook + essentials over noisy sources)
Family: ${playbook.dish_family}
Cuisine lens: ${playbook.cuisine}
IDENTITY DRIVERS — signature ingredients (must be core unless truly substitutable with note): ${playbook.signature_ingredients.join("; ") || "—"}
Signature techniques: ${playbook.signature_techniques.join("; ") || "—"}
Core roles expected: ${playbook.core_roles.join("; ") || "—"}
EXPECTED FLOW (core list must enable this flow):
${flow}
Failure modes to avoid under-supplying: ${playbook.failure_points.join("; ") || "—"}
Serving: ${playbook.serving_style.join("; ") || "—"}
Timing context: ${playbook.timing_expectations.join("; ") || "—"}`;
}

export function playbookForPhaseD(playbook: DynamicPlaybook): string {
  const flow = playbook.expected_flow.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return `DYNAMIC PLAYBOOK — HARD ORDER: each step maps to these beats in sequence (combine beats if needed; never skip a beat).

EXPECTED_FLOW:
${flow}

FAMILY: ${playbook.dish_family} | CUISINE: ${playbook.cuisine}
KEY_TECHNIQUES: ${playbook.key_techniques.join(", ")}
TOOLS: ${playbook.likely_tools.join(", ")}
TIMING: ${playbook.timing_expectations.join("; ")}
FAILURE_POINTS (weave into avoid_mistakes or sparse step warnings): ${playbook.failure_points.join("; ")}
SERVING_STYLE: ${playbook.serving_style.join("; ")}
ANCHORS (honor in titles/instructions): ${playbook.signature_ingredients.join(", ")} | ${playbook.signature_techniques.join(", ")}`;
}

/** Mandatory beats for validation / injection hints */
export function familyMandatoryHints(family: string): string[] {
  const f = family.toLowerCase();
  if (f === "pizza_flatbread")
    return ["dough_rest_or_proof", "preheat_oven", "shape", "high_heat_bake"];
  if (f === "baked_cake") return ["preheat_oven", "bake"];
  if (f === "layered_chilled_dessert")
    return ["chill_or_set", "layer_or_assemble"];
  if (f === "noodle_soup" || f === "rice_plate")
    return ["bowl_assembly_or_serve"];
  if (f === "pasta") return ["sauce_or_finish", "serve"];
  return [];
}

export function familyMandatoryHintsDetailed(family: string): string {
  const f = family.toLowerCase();
  if (f === "baked_cake")
    return "Include: preheat oven to recipe temperature before baking; bake until doneness; cool if needed.";
  if (f === "pizza_flatbread")
    return "Include: dough rest or proof if time allows; preheat oven/stone very hot; shape, top, short high-heat bake.";
  if (f === "layered_chilled_dessert")
    return "Include: chill or refrigerate until set between/final layers; clear layer sequence.";
  if (f === "noodle_soup")
    return "Include: broth depth, noodle cook, bowl assembly (noodles + toppings + hot broth), garnish at service.";
  return "Follow EXPECTED_FLOW beats; no skipped stages.";
}
