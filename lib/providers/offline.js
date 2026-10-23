// Offline provider: no API key needed. "Generates" by personalising the
// target's template (OS name and colour theme pulled from the prompt) and
// "critiques" with pixel statistics only. Useful for demos and for testing.

const THEMES = {
  blue:   { attr: "0x1F", top: [18, 32, 74], bottom: [6, 10, 26], accent: [52, 211, 255], title: [30, 64, 140], ansi: 36 },
  red:    { attr: "0x4F", top: [110, 24, 40], bottom: [28, 6, 12], accent: [255, 110, 120], title: [140, 30, 50], ansi: 31 },
  green:  { attr: "0x2F", top: [12, 70, 44], bottom: [4, 20, 12], accent: [90, 240, 150], title: [20, 100, 60], ansi: 32 },
  purple: { attr: "0x5F", top: [60, 30, 110], bottom: [14, 8, 34], accent: [200, 140, 255], title: [90, 50, 160], ansi: 35 },
  amber:  { attr: "0x6F", top: [110, 60, 10], bottom: [30, 14, 4], accent: [255, 190, 70], title: [140, 80, 20], ansi: 33 },
  cyan:   { attr: "0x3F", top: [10, 70, 80], bottom: [4, 18, 24], accent: [80, 230, 240], title: [16, 100, 110], ansi: 36 },
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

const rgb = ([r, g, b]) => `RGB(${r}, ${g}, ${b})`;

function createOfflineProvider() {
  return {
    name: "offline",
    describe: () => "offline templates (set ANTHROPIC_API_KEY for AI synthesis)",

    async generate({ prompt, tier, templateFiles, previousFiles }) {
      if (previousFiles) return { files: previousFiles, notes: "Offline mode cannot change code; kept the current files." };
      const name = pickName(prompt);
      const osName = /os$/i.test(name) ? name : `${name} OS`;
      const themeName = pickTheme(prompt);
      const theme = THEMES[themeName];
      const files = { ...templateFiles };
      if (tier.builder === "linux") {
        files["rootfs/etc/hostname"] = `${name.toLowerCase()}\n`;
        files["rootfs/etc/motd"] = files["rootfs/etc/motd"].replace("Forge OS", osName);
        files["src/kcpanel.c"] = files["src/kcpanel.c"]
          .replace('"Forge OS  -  KernelCraft Linux Forge"', `"${osName}  -  KernelCraft Linux Forge"`)
          .replace("\\033[44;97m", `\\033[${theme.ansi + 10};97m`);
      } else if (tier.mode === "flat") {
        files["kernel.asm"] = files["kernel.asm"]
          .replace("KernelCraft OS  |", `${osName}  |`)
          .replace("Welcome to KernelCraft OS.", `Welcome to ${osName}.`)
          .replace(/TITLE_ATTR  equ 0x1F/, `TITLE_ATTR  equ ${theme.attr}`);
      } else {
        files["theme.c"] = `/* ${osName} theme: name and colours, applied at boot. */
#include "kc.h"

static void apply_theme(void)
{
    theme.os_name = "${osName}";
    theme.desktop_top = ${rgb(theme.top)};
    theme.desktop_bottom = ${rgb(theme.bottom)};
    theme.accent = ${rgb(theme.accent)};
    theme.title_active = ${rgb(theme.title)};
}
KC_BOOT_HOOK(apply_theme);
`;
      }
      return { files, notes: `Personalised the ${tier.label} template: name "${osName}", ${themeName} theme.` };
    },

    async critique({ stats, crashed }) {
      if (crashed) return { pass: false, summary: "VM reset before the screenshot", issues: ["CPU triple-faulted during boot"] };
      if (!stats || stats.blank) return { pass: false, summary: "Screen is blank", issues: ["Nothing was drawn before the screenshot"] };
      if (stats.distinctColours < 3) return { pass: false, summary: "Screen has almost no content", issues: ["Only one or two colours on screen"] };
      return { pass: true, summary: `Heuristic check: ${stats.distinctColours} colours, ${Math.round(stats.litShare * 100)}% lit pixels`, issues: [] };
    },
  };
}

module.exports = { createOfflineProvider };
