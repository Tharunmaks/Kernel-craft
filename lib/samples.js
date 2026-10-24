// Sample floppy images: the stock 16-bit and 32-bit templates, plus the
// showcase OS (32-bit desktop with every catalog app at 1024x768).
const fs = require("fs/promises");
const { getTier } = require("./tiers");
const { buildArtifacts, makeWorkDir, readTemplate } = require("./toolchain");
const hardware = require("./hardware");
const apps = require("./apps");

const SAMPLES = ["real16", "prot32", "showcase"];

async function buildSample(name) {
  if (!SAMPLES.includes(name)) throw new Error(`Unknown sample "${name}"`);
  const tier = getTier(name === "showcase" ? "prot32" : name);
  let files = await readTemplate(tier);
  let hw;
  if (name === "showcase") {
    files = apps.showcaseFiles(files, tier);
    hw = hardware.normalize(apps.SHOWCASE_HARDWARE, tier).hw;
  }
  const workDir = await makeWorkDir();
  try {
    return (await buildArtifacts(files, tier, workDir, hw)).artifacts["floppy.img"];
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

module.exports = { SAMPLES, buildSample };
