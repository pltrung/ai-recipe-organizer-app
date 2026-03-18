import type { RecipeStep } from "./types";

const STEP_INSTRUCTOR_SYSTEM = `You are a professional chef and cooking instructor.

You are given messy or incomplete recipe steps.

Your job is to rewrite them into clear, structured, beginner-friendly instructions.

For each step:
- Use action verbs (add, boil, simmer, chop, mix, etc.)
- Be explicit and precise
- Include estimated time (e.g. "5 minutes", "until golden", "2–3 hours")
- Include tools if relevant (knife, pot, whisk, etc.) — use tools array
- Include what the result should look like (goal)

Return STRICT JSON only, no markdown:
{
  "steps": [
    {
      "title": string,
      "instructions": string,
      "time": string,
      "tools": string[],
      "goal": string
    }
  ]
}

Rules:
- DO NOT output vague labels like "Broth" as a step title — titles must describe the action (e.g. "Simmer the broth")
- DO NOT skip steps
- Break large steps into multiple smaller steps if needed
- Keep steps concise but complete
- Assume user is beginner-level
- tools can be empty array if none needed`;

function normalizeStep(raw: Record<string, unknown>, index: number): RecipeStep {
  const title =
    typeof raw.title === "string" && raw.title.trim()
      ? raw.title.trim()
      : `Step ${index + 1}`;
  const instructions =
    typeof raw.instructions === "string" && raw.instructions.trim()
      ? raw.instructions.trim()
      : typeof raw.instruction === "string"
        ? raw.instruction.trim()
        : "";
  const time =
    typeof raw.time === "string" && raw.time.trim()
      ? raw.time.trim()
      : "As needed";
  const tools = Array.isArray(raw.tools)
    ? raw.tools.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const goal =
    typeof raw.goal === "string" && raw.goal.trim()
      ? raw.goal.trim()
      : "Complete this step before moving on.";
  return { title, instructions, time, tools, goal };
}

const CANONICAL_APPEND = `

When CANONICAL_STEP_PLAN is provided:
- Output exactly ONE linear recipe (6–10 steps, max 12). Follow the plan stage order.
- No "To marinate / For the sauce" section titles — action titles only.
- Do NOT merge two full alternate methods; one dominant flow only.`;

/**
 * Final AI pass: turn plain step lines into structured, beginner-friendly steps.
 */
export async function finalizeStructuredSteps(
  stepLines: string[],
  openaiApiKey: string,
  opts?: { canonicalSpine?: string }
): Promise<RecipeStep[] | null> {
  const lines = stepLines.map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  if (!openaiApiKey?.trim()) return null;

  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({ apiKey: openaiApiKey });
  const numbered = lines
    .map((s, i) => `${i + 1}. ${s}`)
    .join("\n")
    .slice(0, 14000);

  const spine = opts?.canonicalSpine?.trim();
  const system = spine
    ? STEP_INSTRUCTOR_SYSTEM + CANONICAL_APPEND
    : STEP_INSTRUCTOR_SYSTEM;
  const user = spine
    ? `CANONICAL_STEP_PLAN (mandatory single flow):\n${spine.slice(0, 24_000)}\n\nReference procedural lines (compress into one timeline):\n${numbered}`
    : `Rewrite these recipe steps into structured beginner instructions:\n\n${numbered}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: user,
        },
      ],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { steps?: unknown };
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return null;
    }
    const out: RecipeStep[] = [];
    const cap = spine ? 12 : 24;
    for (let i = 0; i < parsed.steps.length && out.length < cap; i++) {
      const item = parsed.steps[i];
      if (!item || typeof item !== "object") continue;
      const step = normalizeStep(item as Record<string, unknown>, i);
      if (step.instructions) out.push(step);
    }
    return out.length > 0 ? out : null;
  } catch (e) {
    console.error("[structuredSteps] finalize error:", e);
    return null;
  }
}

const PREFIXES = ["Do:", "Then:", "Next:", "Now:"];

/**
 * If AI fails: split long text, prepend action prefixes, ensure non-empty steps.
 */
export function fallbackStructuredSteps(stepLines: string[]): RecipeStep[] {
  const out: RecipeStep[] = [];
  let prefixIdx = 0;

  for (const line of stepLines) {
    const trimmed = line.trim().replace(/^\d+[\).\]]\s*/, "");
    if (!trimmed) continue;

    const chunks = trimmed.includes("\n\n")
      ? trimmed.split(/\n\n+/).map((c) => c.trim()).filter(Boolean)
      : trimmed.length > 280
        ? trimmed.split(/(?<=[.!?])\s+/).filter((c) => c.trim().length > 15)
        : [trimmed];

    for (const chunk of chunks) {
      const c = chunk.trim();
      if (!c) continue;
      const prefix = PREFIXES[prefixIdx % PREFIXES.length];
      prefixIdx++;
      const shortTitle =
        c.length > 50 ? c.slice(0, 47).replace(/\s+\S*$/, "") + "…" : c;
      out.push({
        title: shortTitle.slice(0, 60) || `Step ${out.length + 1}`,
        instructions: `${prefix} ${c}`,
        time: "As needed",
        tools: [],
        goal: "Finish this step completely before continuing.",
      });
    }
  }

  if (out.length === 0 && stepLines.some((s) => s.trim())) {
    return fallbackStructuredSteps(["Complete the recipe as described in your sources."]);
  }

  return out;
}

/** Merge / display: structured or legacy steps → plain lines for AI context */
export function stepsRowToPlainStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t) out.push(t);
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      if (typeof o.instructions === "string" && o.instructions.trim()) {
        const title =
          typeof o.title === "string" && o.title.trim()
            ? `${o.title.trim()}: `
            : "";
        out.push(title + o.instructions.trim());
      }
    }
  }
  return out;
}
