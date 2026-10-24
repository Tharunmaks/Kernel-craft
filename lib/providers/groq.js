// Groq provider (OpenAI-compatible chat completions API): code synthesis on
// a large open model and screenshot critique on a vision model.
// Env: GROQ_API_KEY (required), GROQ_MODEL, GROQ_CRITIC_MODEL.
const prompts = require("../prompts");

const BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const DEFAULT_CRITIC = "meta-llama/llama-4-scout-17b-16e-instruct";
const MAX_RETRIES = 3;

// Anthropic-style content (string or text/image blocks) -> OpenAI message content.
function toOpenAIContent(content) {
  if (typeof content === "string") return content;
  return content.map((b) => b.type === "image"
    ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
    : { type: "text", text: b.text });
}

function createGroqProvider({
  apiKey = process.env.GROQ_API_KEY,
  model = process.env.GROQ_MODEL || DEFAULT_MODEL,
  criticModel = process.env.GROQ_CRITIC_MODEL || DEFAULT_CRITIC,
  baseURL = process.env.GROQ_BASE_URL || BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  async function ask({ model, system, content, maxTokens }) {
    const body = JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: toOpenAIContent(content) }],
    });
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
      });
      // Free-tier rate limits are tight; wait as told and retry.
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const wait = Math.min(30, Number(res.headers.get("retry-after")) || 2 ** (attempt + 1));
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Groq ${model}: ${data.error?.message || `HTTP ${res.status}`}`);
      const choice = data.choices?.[0];
      return { text: choice?.message?.content || "", model: data.model || model, truncated: choice?.finish_reason === "length" };
    }
  }

  return {
    name: "groq",
    complete: ({ system, content, maxTokens = 32000 }) => ask({ model, system, content, maxTokens: Math.min(maxTokens, 32000) }),
    describe: () => `Groq (${model}, critic ${criticModel})`,

    async generate({ prompt, tier, templateFiles, previousFiles, feedback, pass }) {
      const res = await ask({
        model,
        system: prompts.generatorSystem(tier),
        content: prompts.generatorUser({ prompt, templateFiles, previousFiles, feedback, pass }),
        maxTokens: 32000,
      });
      const out = prompts.parseFiles(res.text);
      if (res.truncated) out.notes = `${out.notes} (reply hit the token limit; files may be incomplete)`.trim();
      if (!Object.keys(out.files).length) throw new Error("Generator returned no <file> blocks");
      return out;
    },

    async critique({ prompt, tier, png, stats, serialLog, crashed }) {
      const res = await ask({
        model: criticModel,
        system: prompts.criticSystem(tier),
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
          { type: "text", text: prompts.criticUser({ prompt, stats, serialLog, crashed }) },
        ],
        maxTokens: 4000,
      });
      return prompts.parseVerdict(res.text);
    },
  };
}

module.exports = { createGroqProvider };
