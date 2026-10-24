// Claude provider: code synthesis (Agent 1) and screenshot critique (Agent 2).
const Anthropic = require("@anthropic-ai/sdk");
const prompts = require("../prompts");

const DEFAULT_MODEL = "claude-opus-5-5";

function createAnthropicProvider({
  model = process.env.KC_MODEL || DEFAULT_MODEL,
  criticModel = process.env.KC_CRITIC_MODEL || model,
  client = new Anthropic(),
} = {}) {
  // Server-side fallbacks re-run a request on another model if a safety
  // classifier declines it (low-level systems code can trip the cyber one).
  async function ask({ model, system, content, effort, maxTokens }) {
    const stream = client.beta.messages.stream({
      model,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort },
      system,
      messages: [{ role: "user", content }],
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") {
      const why = msg.stop_details?.explanation || msg.stop_details?.category || "no details";
      throw new Error(`${model} declined the request (${why})`);
    }
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return { text, model: msg.model, truncated: msg.stop_reason === "max_tokens" };
  }

  return {
    name: "anthropic",
    // Generic call used by the big-OS agents (architect, writers, fixer).
    complete: ({ system, content, effort = "high", maxTokens = 64000 }) => ask({ model, system, content, effort, maxTokens }),
    describe: () => `Claude (${model}${criticModel !== model ? `, critic ${criticModel}` : ""})`,

    async generate({ prompt, tier, templateFiles, previousFiles, feedback, pass }) {
      const res = await ask({
        model,
        system: prompts.generatorSystem(tier),
        content: prompts.generatorUser({ prompt, templateFiles, previousFiles, feedback, pass }),
        effort: "high",
        maxTokens: 64000,
      });
      const out = prompts.parseFiles(res.text);
      if (res.truncated) out.notes = `${out.notes} (reply hit max_tokens; files may be incomplete)`.trim();
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
        effort: "medium",
        maxTokens: 16000,
      });
      return prompts.parseVerdict(res.text);
    },
  };
}

module.exports = { createAnthropicProvider };
