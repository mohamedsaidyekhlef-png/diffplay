import type { Walkthrough } from "./types.js";

/**
 * Optional model narration. Bring your own key; nothing is sent anywhere
 * unless one of these is set:
 *   ANTHROPIC_API_KEY                      → Claude
 *   OPENAI_API_KEY (+ OPENAI_BASE_URL)     → OpenAI or any compatible API (OpenRouter, Groq, Together…)
 *   DIFFPLAY_OLLAMA=1 (+ OLLAMA_HOST)      → local model via Ollama, fully offline
 * DIFFPLAY_MODEL overrides the model name for any provider.
 */
export interface Provider {
  name: string;
  model: string;
  call: (system: string, user: string) => Promise<string>;
}

export function detectProvider(env = process.env): Provider | null {
  const model = env.DIFFPLAY_MODEL;
  if (env.ANTHROPIC_API_KEY) {
    const m = model ?? "claude-sonnet-5-5";
    return {
      name: "Claude",
      model: m,
      call: async (system, user) => {
        const res = await fetch(`${env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY!,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({ model: m, max_tokens: 16000, system, messages: [{ role: "user", content: user }] }),
        });
        if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = (await res.json()) as { content: { type: string; text?: string }[] };
        return data.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      },
    };
  }
  const openaiCompatible = (name: string, base: string, key: string | undefined, m: string): Provider => ({
    name,
    model: m,
    call: async (system, user) => {
      const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model: m,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) throw new Error(`${name} API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      return data.choices[0]?.message?.content ?? "";
    },
  });
  if (env.OPENAI_API_KEY) {
    return openaiCompatible("OpenAI-compatible", env.OPENAI_BASE_URL ?? "https://api.openai.com/v1", env.OPENAI_API_KEY, model ?? "gpt-5-mini");
  }
  if (env.DIFFPLAY_OLLAMA) {
    return openaiCompatible("Ollama", `${env.OLLAMA_HOST ?? "http://localhost:11434"}/v1`, undefined, model ?? "qwen2.5-coder:7b");
  }
  return null;
}

const SYSTEM = `You are a senior engineer helping a teammate review a pull request that was probably written by an AI coding agent.
You get the change already split into ordered steps. Explain it so a reviewer understands it in two minutes.
Rules:
- Plain English, short sentences, no hype, no praise.
- Say WHY each step exists and what it does, not a line-by-line list.
- If something looks wrong, risky, inconsistent between steps, or untested, say so directly in that step.
- Never invent files or behaviour that is not in the diff.
Reply with JSON only:
{"title": "<what this PR does, max 10 words>",
 "summary": "<2-3 sentences: what changed, why, and the single most important thing to check>",
 "steps": [{"id": <step id>, "narration": "<1-2 sentences>"}]}`;

const MAX_CHARS_PER_FILE = 6000;
const MAX_TOTAL = 90_000;

function compactDiff(w: Walkthrough): string {
  let out = "";
  for (const s of w.steps) {
    out += `\n### Step ${s.id}: ${s.title}\n`;
    for (const f of s.files) {
      let body = `--- ${f.path} (${f.status}, +${f.additions} −${f.deletions})\n`;
      for (const h of f.hunks) {
        body += h.header + "\n";
        for (const l of h.lines) {
          const flag = l.risks.length ? `   ⟵ ${l.risks.map((r) => r.label).join(", ")}` : "";
          body += (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text + flag + "\n";
        }
      }
      if (body.length > MAX_CHARS_PER_FILE) body = body.slice(0, MAX_CHARS_PER_FILE) + "\n… (truncated)\n";
      out += body;
      if (out.length > MAX_TOTAL) return out.slice(0, MAX_TOTAL) + "\n… (diff truncated for length)";
    }
  }
  return out;
}

function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("model did not return JSON");
  return JSON.parse(text.slice(start, end + 1));
}

/** Replace heuristic narration with model narration. Falls back silently on any failure. */
export async function narrate(w: Walkthrough, provider: Provider, context?: string): Promise<{ ok: boolean; error?: string }> {
  const user =
    (context ? `PR description from the author:\n${context.slice(0, 4000)}\n\n` : "") +
    `Steps and diff (risk flags from a static scanner are marked with ⟵):\n${compactDiff(w)}`;
  try {
    const parsed = extractJson(await provider.call(SYSTEM, user));
    if (typeof parsed.title === "string" && parsed.title.trim()) w.title = parsed.title.trim();
    if (typeof parsed.summary === "string" && parsed.summary.trim()) w.summary = parsed.summary.trim();
    if (Array.isArray(parsed.steps)) {
      for (const s of parsed.steps) {
        const step = w.steps.find((x) => x.id === Number(s.id));
        if (step && typeof s.narration === "string" && s.narration.trim()) step.narration = s.narration.trim();
      }
    }
    w.narratedBy = `${provider.name} (${provider.model})`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
