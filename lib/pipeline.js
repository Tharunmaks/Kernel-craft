// The multi-agent loop: synthesise -> build -> boot + screenshot -> critique,
// feeding build errors and critic issues back to the generator.
//
// Two generation strategies:
//   classic  one model reply holds every file (16-bit, offline mode, Plus plan)
//   big      architect + parallel writers + per-file repair (lib/bigmode.js)
const fs = require("fs/promises");
const hardware = require("./hardware");
const { buildArtifacts, bootAndCapture, makeWorkDir, readTemplate, BuildError } = require("./toolchain");
const bigmode = require("./bigmode");

const FEEDBACK_LIMIT = 8000;
const COMPILE_FIX_ROUNDS = 2;

async function buildOS({
  prompt,
  tier,
  provider,
  maxPasses = 3,
  bigFiles = 0,          // >0 enables big mode with this many planned files
  baseFiles = null,      // existing project files (follow-up edits)
  changeRequest = null,  // follow-up edit request
  manualFiles = null,    // build these files as-is, no AI
  extraFiles = null,     // catalog apps added to the base before generation
  hardware: hwInput = null, // Hardware panel settings (CPU, RAM, graphics)
  emit = () => {},
}) {
  const log = (agent, message) => emit({ type: "log", agent, message });
  const templateFiles = { ...(await readTemplate(tier)), ...(extraFiles || {}) };
  if (baseFiles && extraFiles) baseFiles = { ...baseFiles, ...extraFiles };
  const { hw, notes: hwNotes } = hardware.normalize(hwInput, tier);
  const big = !manualFiles && bigFiles > 0 && typeof provider.complete === "function" && tier.mode !== "flat";
  const passes = [];
  let files = null;
  let plan = null;
  let feedback = null;
  let best = null;

  log("system", manualFiles
    ? `Building your edited sources for ${tier.label} (no AI).`
    : `Target ${tier.label} via ${provider.describe()}; ${big ? `big-OS mode, up to ${bigFiles} AI-written files, ` : ""}up to ${maxPasses} verification passes.`);

  // The agents see the machine spec alongside the user's request.
  if (!manualFiles) prompt = `${prompt}\n\nTarget machine: ${hardware.describe(hw)}.`;
  log("system", `Virtual machine: ${hardware.describe(hw)}${hwNotes.length ? ` (${hwNotes.join("; ")})` : ""}.`);
  if (extraFiles) log("system", `Adding apps: ${Object.keys(extraFiles).join(", ")}`);

  for (let pass = 1; pass <= maxPasses; pass++) {
    // ---- synthesise or repair
    if (manualFiles) {
      files = manualFiles;
    } else if (pass === 1) {
      if (big) {
        const gen = await bigmode.generate({ provider, tier, prompt, baseFiles: baseFiles || templateFiles, maxFiles: bigFiles, changeRequest, emit });
        files = gen.files;
        plan = gen.plan;
      } else {
        log("generator", changeRequest ? "Applying your change..." : "Synthesising boot sector and kernel...");
        const gen = await provider.generate({ prompt, tier, templateFiles, previousFiles: baseFiles, feedback: changeRequest, pass: 0 });
        files = gen.files;
        log("generator", `${Object.keys(gen.files).length} files${gen.notes ? ` | ${gen.notes}` : ""}`);
      }
    } else if (big) {
      files = (await bigmode.repair({ provider, tier, prompt, plan, files, problem: feedback.text, kind: feedback.kind, emit })).files;
    } else {
      log("generator", `Pass ${pass}: repairing code from feedback...`);
      const gen = await provider.generate({ prompt, tier, templateFiles, previousFiles: files, feedback: feedback.text, pass });
      files = gen.files;
      log("generator", `${Object.keys(files).length} files${gen.notes ? ` | ${gen.notes}` : ""}`);
    }

    const workDir = await makeWorkDir();
    const record = { pass, files };
    passes.push(record);
    try {
      // ---- build (big mode gets quick compile-fix rounds inside the pass)
      let built = null;
      for (let round = 0; ; round++) {
        try {
          built = await buildArtifacts(files, tier, workDir, hw);
          break;
        } catch (err) {
          if (!(err instanceof BuildError)) throw err;
          const toolLog = (err.log || err.message).slice(-FEEDBACK_LIMIT);
          log("builder", `${err.message}:\n${toolLog.slice(-1500)}`);
          if (big && round < COMPILE_FIX_ROUNDS) {
            files = (await bigmode.repair({ provider, tier, prompt, plan, files, problem: toolLog, kind: "build", emit })).files;
            record.files = files;
            continue;
          }
          record.stage = "build";
          record.verdict = { pass: false, summary: err.message, issues: [toolLog] };
          emit({ type: "pass", pass, stage: "build", verdict: record.verdict });
          feedback = { kind: "build", text: `The build failed (${err.message}). Toolchain output:\n${toolLog}` };
          break;
        }
      }
      if (!built) continue;
      record.artifacts = built.artifacts;
      log("builder", `${built.summary}`);

      // ---- boot + screenshot
      log("runner", `Booting ${tier.qemu} headless, screenshot after ${tier.bootWaitMs} ms...`);
      const shot = await bootAndCapture(tier, workDir, { hw });
      record.stage = "boot";
      record.png = shot.png;
      record.stats = shot.stats;
      record.serialLog = shot.serialLog;
      if (shot.serialLog) log("runner", `serial: ${shot.serialLog.slice(-600)}`);

      // ---- critique (obvious failures need no vision model)
      if (shot.crashed || !shot.png) {
        record.verdict = {
          pass: false,
          summary: shot.crashed ? "VM reset before the screenshot (triple fault)" : "No screenshot captured",
          issues: [shot.crashed ? "The CPU triple-faulted during boot. Check the GDT, segment reloads, stack, page tables and far jumps." : `QEMU did not produce a screenshot. ${shot.qemuOutput}`],
        };
      } else if (shot.stats.blank) {
        record.verdict = { pass: false, summary: "Screen is blank", issues: ["Nothing was drawn before the screenshot; the system likely hangs or never reaches its draw code."] };
      } else if (/KERNEL PANIC|Kernel panic/.test(shot.serialLog || "")) {
        record.verdict = { pass: false, summary: "Kernel panic", issues: [`The kernel panicked: ${(shot.serialLog.match(/.*[Pp]anic.*/) || [""])[0]}`] };
      } else {
        log("critic", "Inspecting framebuffer screenshot...");
        const critic = manualFiles ? require("./providers/offline").createOfflineProvider() : provider;
        record.verdict = await critic.critique({ prompt, tier, png: shot.png, stats: shot.stats, serialLog: shot.serialLog, crashed: shot.crashed });
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

      if (shot.png && !shot.stats?.blank && !shot.crashed) best = record; // latest build that showed something
      if (record.verdict.pass) break;
      const issues = record.verdict.issues.map((i) => `- ${i}`).join("\n") || record.verdict.summary;
      feedback = { kind: "visual", text: `The OS built and booted, but the screenshot check failed: ${record.verdict.summary}\n${issues}${shot.serialLog ? `\nSerial log:\n${shot.serialLog.slice(-1500)}` : ""}` };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  const final = passes.find((p) => p.verdict?.pass) || best || [...passes].reverse().find((p) => p.artifacts);
  const verified = Boolean(final?.verdict?.pass);
  log("system", final ? (verified ? `Verified on pass ${final.pass}.` : `Not verified after ${passes.length} passes; returning pass ${final.pass}.`) : "No pass produced a bootable build.");
  return { verified, final, passes, plan, lastFiles: files, hardware: hw };
}

module.exports = { buildOS };
