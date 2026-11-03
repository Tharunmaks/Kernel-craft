// OpenRouter provider (OpenAI-compatible API, one key for hundreds of models).
// Defaults to free models: a large coding model writes the OS, a vision model
// judges screenshots. Free models come and go, so each role has a fallback
// list and the next model is tried when one is unavailable or rate limited.
// Env: OPENROUTER_API_KEY (required), OPENROUTER_MODEL, OPENROUTER_CRITIC_MODEL
// (each may be a comma-separated list, tried in order).
const prompts = require("../prompts");

const BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "cohere/north-mini-code:free",
  "google/gemma-4-31b-it:free",
];
const DEFAULT_CRITICS = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "google/gemma-4-26b-a4b-it:free",
];
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 15 * 60 * 1000;

const list = (v, fallback) => (v ? String(v).split(",").map((s) => s.trim()).filter(Boolean) : fallback);

// Anthropic-style content (string or text/image blocks) -> OpenAI message content.
function toOpenAIContent(content) {
  if (typeof content === "string") return content;
  return content.map((b) => b.type === "image"
    ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
    : { type: "text", text: b.text });
}

// Errors that mean "try another model" rather than "give up".
const switchable = (status, msg) => status === 404 || status === 429 || status >= 500 || status === 402
  || /no endpoints|not a valid model|unavailable|rate.?limit|overloaded|image input|does not support/i.test(msg || "");

function createOpenRouterProvider({
  apiKey = process.env.OPENROUTER_API_KEY,
  models = list(process.env.OPENROUTER_MODEL, DEFAULT_MODELS),
  criticModels = list(process.env.OPENROUTER_CRITIC_MODEL, DEFAULT_CRITICS),
  baseURL = process.env.OPENROUTER_BASE_URL || BASE_URL,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  async function askOne({ model, system, content, maxTokens }) {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: toOpenAIContent(content) }],
    });
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${baseURL}/chat/completions`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "HTTP-Referer": "https://github.com/Tharunmaks/Kernel-craft",
            "X-Title": "KernelCraft",
          },
          body,
        });
      } catch (cause) {
        // Timeouts and dropped connections: let the next model try.
        const err = new Error(`OpenRouter ${model}: ${cause.name === "TimeoutError" ? "timed out" : cause.message}`);
        err.switchable = true;
        throw err;
      }
      const data = await res.json().catch(() => ({}));
      const msg = data.error?.message || (res.ok ? "" : `HTTP ${res.status}`);
      // OpenRouter can report upstream errors inside a 200 response.
      const status = res.ok && data.error ? Number(data.error.code) || 502 : res.status;
      if (res.ok && !data.error) {
        const choice = data.choices?.[0];
        const text = choice?.message?.content || "";
        if (text) return { text, model: data.model || model, truncated: choice?.finish_reason === "length" };
        if (attempt < MAX_RETRIES) continue; // empty reply: free endpoints do this under load
        const err = new Error(`OpenRouter ${model}: empty reply`);
        err.switchable = true;
        throw err;
      }
      // The account's daily free-model allowance is shared by every model,
      // so switching or retrying cannot help: stop with a clear message.
      if (/free-models-per-day|per.?day/i.test(msg)) {
        const err = new Error("OpenRouter daily free-model limit reached (50 requests a day without credits, 1000 with $10 of credits). Try again after midnight UTC or add credits.");
        err.status = 429;
        err.fatal = true;
        throw err;
      }
      if ((status === 429 || status >= 500) && attempt < MAX_RETRIES) {
        await sleep(Math.min(20, Number(res.headers?.get?.("retry-after")) || 2 ** (attempt + 1)) * 1000);
        continue;
      }
      const err = new Error(`OpenRouter ${model}: ${msg}`);
      err.status = status;
      err.switchable = switchable(status, msg);
      throw err;
    }
  }

  // Try each model of a role in order; remember the one that worked.
  const preferred = new Map();
  async function ask({ role, system, content, maxTokens }) {
    const pool = role === "critic" ? criticModels : models;
    const first = preferred.get(role);
    const order = first ? [first, ...pool.filter((m) => m !== first)] : pool;
    let lastErr;
    for (const model of order) {
      try {
        const out = await askOne({ model, system, content, maxTokens });
        preferred.set(role, model);
        return out;
      } catch (err) {
        lastErr = err;
        if (!err.switchable) throw err;
      }
    }
    throw lastErr;
  }

  const image = (png) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });

  return {
    name: "openrouter",
    describe: () => `OpenRouter (${preferred.get("main") || models[0]}, critic ${preferred.get("critic") || criticModels[0]})`,
    complete: ({ system, content, maxTokens = 32000 }) => ask({ role: "main", system, content, maxTokens: Math.min(maxTokens, 32000) }),
    // Vision call used by the scorer: text plus a screenshot.
    see: ({ system, text, png, maxTokens = 6000 }) => ask({ role: "critic", system, content: [image(png), { type: "text", text }], maxTokens }),

    async generate({ prompt, tier, templateFiles, previousFiles, feedback, pass }) {
      const res = await ask({
        role: "main",
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
        role: "critic",
        system: prompts.criticSystem(tier),
        content: [image(png), { type: "text", text: prompts.criticUser({ prompt, stats, serialLog, crashed }) }],
        maxTokens: 4000,
      });
      return prompts.parseVerdict(res.text);
    },
  };
}

module.exports = { createOpenRouterProvider, DEFAULT_MODELS, DEFAULT_CRITICS };
