// Provider registry. A provider is an object with:
//   name, describe()
//   generate({ prompt, tier, templateFiles, previousFiles, feedback, pass }) -> { files, notes }
//   critique({ prompt, tier, png, stats, serialLog, crashed }) -> { pass, summary, issues }
// To add another vendor (e.g. Gemini), implement those two methods in a new
// file using lib/prompts.js and register it below.
const { createAnthropicProvider } = require("./anthropic");
const { createOfflineProvider } = require("./offline");

const FACTORIES = {
  anthropic: createAnthropicProvider,
  offline: createOfflineProvider,
};

function createProvider(name = process.env.KC_PROVIDER) {
  const hasClaudeCreds = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  const chosen = name || (hasClaudeCreds ? "anthropic" : "offline");
  const factory = FACTORIES[chosen];
  if (!factory) throw new Error(`Unknown KC_PROVIDER "${chosen}". Available: ${Object.keys(FACTORIES).join(", ")}`);
  return factory();
}

module.exports = { createProvider, providers: Object.keys(FACTORIES) };
