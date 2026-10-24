// Builds the GitHub Pages version of KernelCraft into dist/: the web app in
// static mode, the v86 emulator, and prebuilt sample images (including the
// showcase OS with every app). Needs nasm and gcc with -m32 (no QEMU).
//   node scripts/build-static.js [outDir]
const fs = require("fs");
const path = require("path");
const { TARGETS, getTier } = require("../lib/tiers");
const { readTemplate } = require("../lib/toolchain");
const { publicPlans, planForTarget } = require("../lib/plans");
const hardware = require("../lib/hardware");
const apps = require("../lib/apps");
const { SAMPLES, buildSample } = require("../lib/samples");

const ROOT = path.join(__dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "dist"));
// owner/repo, from GitHub Actions or the git remote.
const REPO = process.env.GITHUB_REPOSITORY || "Tharunmaks/Kernel-craft";

function copy(from, to) {
  fs.mkdirSync(path.dirname(path.join(OUT, to)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, from), path.join(OUT, to));
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8")
    .replace("<script src=\"app.js\" defer></script>", "<script>window.KC_STATIC = true;</script>\n  <script src=\"app.js\" defer></script>");
  fs.writeFileSync(path.join(OUT, "index.html"), html);
  copy("public/styles.css", "styles.css");
  copy("public/app.js", "app.js");
  copy("node_modules/v86/build/libv86.js", "vendor/libv86.js");
  copy("node_modules/v86/build/v86.wasm", "vendor/v86.wasm");
  copy("vendor/bios/seabios.bin", "vendor/bios/seabios.bin");
  copy("vendor/bios/vgabios.bin", "vendor/bios/vgabios.bin");

  fs.mkdirSync(path.join(OUT, "sdk"), { recursive: true });
  fs.writeFileSync(path.join(OUT, "sdk/kc.h"), (await readTemplate(getTier("prot32")))["kc.h"]);

  fs.mkdirSync(path.join(OUT, "samples"), { recursive: true });
  for (const name of SAMPLES) {
    const image = await buildSample(name);
    fs.writeFileSync(path.join(OUT, "samples", `${name}.img`), image);
    console.log(`samples/${name}.img (${image.length} bytes)`);
  }

  const config = {
    static: true,
    provider: "GitHub Pages demo (no AI builds)",
    billing: { razorpay: false, keyId: null, devBilling: false },
    plans: publicPlans(),
    targets: Object.values(TARGETS).map(({ id, label, browserBootable, builder }) => ({ id, label, browserBootable, builder, plan: planForTarget(id).id })),
    hardware: hardware.options(),
    apps: apps.list(),
    showcaseHardware: apps.SHOWCASE_HARDWARE,
    repo: `https://github.com/${REPO}`,
    codespaces: `https://codespaces.new/${REPO}?quickstart=1`,
  };
  fs.writeFileSync(path.join(OUT, "static.json"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
  console.log(`static site written to ${path.relative(ROOT, OUT) || OUT}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
