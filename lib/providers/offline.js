// Offline provider: no API key needed. "Generates" by personalising the tier
// template (OS name and colour theme pulled from the prompt) and "critiques"
// with pixel statistics only. Useful for demos and for testing the pipeline.

const THEMES = {
  red:    { attr: "0x4F", gradient: "14 + i * 2, 2 + i / 2, 4 + i" },
  green:  { attr: "0x2F", gradient: "2 + i / 2, 12 + i * 2, 4 + i" },
  purple: { attr: "0x5F", gradient: "10 + i, 2 + i / 2, 14 + i * 2" },
  amber:  { attr: "0x6F", gradient: "14 + i * 2, 8 + i, 1" },
  cyan:   { attr: "0x3F", gradient: "1, 10 + i * 2, 14 + i * 2" },
  blue:   { attr: "0x1F", gradient: "2 + i / 2, 4 + i, 14 + i * 2" },
};
const THEME_WORDS = [
  [/\b(red|crimson|scarlet)\b/i, "red"],
  [/\b(green|matrix|emerald)\b/i, "green"],
  [/\b(purple|violet|magenta|pink)\b/i, "purple"],
  [/\b(amber|orange|yellow|gold)\b/i, "amber"],
  [/\b(cyan|teal|aqua)\b/i, "cyan"],
];

function pickName(prompt) {
  const m = prompt.match(/\b(?:called|named)\s+["']?([A-Za-z0-9][A-Za-z0-9_-]{0,13})/i);
  return m ? m[1].trim() : "KernelCraft";
}

function pickTheme(prompt) {
  const hit = THEME_WORDS.find(([re]) => re.test(prompt));
  return hit ? hit[1] : "blue";
}

function createOfflineProvider() {
  return {
    name: "offline",
    describe: () => "offline templates (set ANTHROPIC_API_KEY for AI synthesis)",

    async generate({ prompt, tier, templateFiles, previousFiles }) {
      if (previousFiles) return { files: templateFiles, notes: "Offline mode cannot repair code; reverted to the stock template." };
      const name = pickName(prompt);
      const theme = THEMES[pickTheme(prompt)];
      const files = { ...templateFiles };
      if (tier.mode === "flat") {
        const osName = /os$/i.test(name) ? name : `${name} OS`;
        files["kernel.asm"] = files["kernel.asm"]
          .replace("KernelCraft OS  |", `${osName}  |`)
          .replace("Welcome to KernelCraft OS.", `Welcome to ${osName}.`)
          .replace(/TITLE_ATTR  equ 0x1F/, `TITLE_ATTR  equ ${theme.attr}`);
      } else {
        files["kernel.c"] = files["kernel.c"]
          .replace('"About KernelCraft"', `"About ${name}"`)
          .replace('"KernelCraft shell ready\\n> "', `"${name} shell ready\\n> "`)
          .replace("2 + i / 2, 4 + i, 14 + i * 2", theme.gradient);
      }
      return { files, notes: `Personalised the ${tier.label} template: name "${name}", ${pickTheme(prompt)} theme.` };
    },

    async critique({ stats, crashed }) {
      if (crashed) return { pass: false, summary: "VM reset before the screenshot", issues: ["CPU triple-faulted during boot"] };
      if (!stats || stats.blank) return { pass: false, summary: "Screen is blank", issues: ["Nothing was drawn within 3 seconds of boot"] };
      if (stats.distinctColours < 3) return { pass: false, summary: "Screen has almost no content", issues: ["Only one or two colours on screen"] };
      return { pass: true, summary: `Heuristic check: ${stats.distinctColours} colours, ${Math.round(stats.litShare * 100)}% lit pixels`, issues: [] };
    },
  };
}

module.exports = { createOfflineProvider };
