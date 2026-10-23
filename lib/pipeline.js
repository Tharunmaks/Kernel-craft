// The multi-agent loop: synthesise -> build -> boot + screenshot -> critique,
// feeding build errors and critic issues back to the generator for up to
// maxPasses passes.
const fs = require("fs/promises");
const { buildImage, bootAndCapture, makeWorkDir, readTemplate, BuildError } = require("./toolchain");

const FEEDBACK_LIMIT = 6000;

async function buildOS({ prompt, tier, provider, maxPasses = 3, bootWaitMs = 3000, emit = () => {} }) {
  const log = (agent, message) => emit({ type: "log", agent, message });
  const templateFiles = await readTemplate(tier);
  const passes = [];
  let previousFiles = null;
  let feedback = null;
  let best = null;

  log("system", `Target ${tier.label} via ${provider.describe()}; up to ${maxPasses} verification passes.`);

  for (let pass = 1; pass <= maxPasses; pass++) {
    log("generator", pass === 1 ? "Synthesising boot sector and kernel..." : `Pass ${pass}: repairing code from feedback...`);
    const gen = await provider.generate({ prompt, tier, templateFiles, previousFiles, feedback, pass });
    previousFiles = gen.files;
    log("generator", `${Object.keys(gen.files).join(", ")}${gen.notes ? ` | ${gen.notes}` : ""}`);

    const workDir = await makeWorkDir();
    const record = { pass, files: gen.files, notes: gen.notes };
    passes.push(record);
    try {
      let built;
      try {
        built = await buildImage(gen.files, tier, workDir);
      } catch (err) {
        if (!(err instanceof BuildError)) throw err;
        record.stage = "build";
        record.verdict = { pass: false, summary: err.message, issues: [err.log || err.message] };
        log("builder", `${err.message}:\n${(err.log || "").slice(-1500)}`);
        emit({ type: "pass", pass, stage: "build", verdict: record.verdict });
        feedback = `The build failed (${err.message}). Toolchain output:\n${(err.log || "").slice(-FEEDBACK_LIMIT)}`;
        continue;
      }
      record.image = built.image;
      log("builder", `floppy.img ready: ${built.kernelBytes} byte kernel in ${built.sectors} sectors.`);

      log("runner", `Booting ${tier.qemu} headless, screenshot after ${bootWaitMs} ms...`);
      const shot = await bootAndCapture(tier, workDir, { bootWaitMs });
      record.stage = "boot";
      record.png = shot.png;
      record.stats = shot.stats;
      if (shot.serialLog) log("runner", `serial: ${shot.serialLog.slice(-400)}`);

      // Obvious failures don't need a vision model to diagnose.
      if (shot.crashed || !shot.png) {
        record.verdict = {
          pass: false,
          summary: shot.crashed ? "VM reset before the screenshot (triple fault)" : "No screenshot captured",
          issues: [shot.crashed ? "The CPU triple-faulted during boot. Check the GDT, segment reloads, stack and far jumps." : `QEMU did not produce a screenshot. ${shot.qemuOutput}`],
        };
      } else if (shot.stats.blank) {
        record.verdict = { pass: false, summary: "Screen is blank", issues: ["Nothing was drawn within 3 seconds of power-on; the kernel likely hangs or never reaches its draw code."] };
      } else {
        log("critic", "Inspecting framebuffer screenshot...");
        record.verdict = await provider.critique({ prompt, tier, png: shot.png, stats: shot.stats, serialLog: shot.serialLog, crashed: shot.crashed });
      }
      log("critic", `${record.verdict.pass ? "PASS" : "FAIL"}: ${record.verdict.summary}${record.verdict.issues.length ? `\n- ${record.verdict.issues.join("\n- ")}` : ""}`);
      emit({
        type: "pass",
        pass,
        stage: "boot",
        screenshot: shot.png ? `data:image/png;base64,${shot.png.toString("base64")}` : null,
        stats: shot.stats,
        verdict: record.verdict,
      });

      if (shot.png && !shot.stats?.blank && !shot.crashed) best = record; // latest image that booted to something
      if (record.verdict.pass) break;
      feedback = record.verdict.issues.map((i) => `- ${i}`).join("\n") || record.verdict.summary;
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  const final = passes.find((p) => p.verdict?.pass) || best || [...passes].reverse().find((p) => p.image);
  const verified = Boolean(final?.verdict?.pass);
  log("system", final ? (verified ? `Verified on pass ${final.pass}.` : `Not verified after ${passes.length} passes; returning pass ${final.pass}.`) : "No pass produced a bootable image.");
  return { verified, final, passes };
}

module.exports = { buildOS };
