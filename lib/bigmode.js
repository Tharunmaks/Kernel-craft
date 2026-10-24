// "Big OS" generation: an Architect agent plans the OS as many files, writer
// agents implement them in parallel (headers first), and repairs rewrite
// only the files that are broken. This scales output far beyond what one
// model reply can hold.
const prompts = require("./prompts");

const WRITER_CONCURRENCY = 4;

function firstComment(src) {
  const m = src.match(/\/\*\s*([^*\n]+)|^\s*(?:;|#|\/\/)\s*([^\n]+)/m);
  return (m ? (m[1] || m[2]) : "").trim().slice(0, 100);
}

function fileIndex(files) {
  return Object.entries(files)
    .map(([name, src]) => `${name} (${src.length} bytes) ${firstComment(src)}`)
    .join("\n");
}

function headersOf(files) {
  return Object.fromEntries(Object.entries(files).filter(([n]) => n.endsWith(".h")));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function validPlanPath(p, tier) {
  if (typeof p !== "string") return false;
  if (tier.builder === "linux") return /^(rootfs\/[A-Za-z0-9._\/-]+|src\/[A-Za-z0-9_-]+\.(c|h))$/.test(p) && !p.includes("..");
  return /^[A-Za-z0-9_-]{1,40}\.(c|h|asm|inc)$/.test(p) && p !== "boot.asm";
}

async function writeFile({ provider, tier, prompt, plan, target, files, instructions, log }) {
  const res = await provider.complete({
    system: prompts.writerSystem(tier),
    content: prompts.writerUser({
      prompt,
      plan,
      target,
      headers: headersOf(files),
      currentContent: files[target.path] ?? null,
      instructions,
    }),
    effort: "high",
    maxTokens: 64000,
  });
  const out = prompts.parseFiles(res.text).files;
  const content = out[target.path] ?? Object.values(out)[0];
  if (!content) throw new Error(`Writer returned no content for ${target.path}`);
  log("writer", `${target.path}: ${content.split("\n").length} lines${res.truncated ? " (hit the output limit)" : ""}`);
  return content;
}

// Writes the planned files: headers one by one (each later writer sees the
// earlier headers), then everything else in parallel.
async function writePlanned({ provider, tier, prompt, plan, files, targets, log }) {
  const result = { ...files };
  const headers = targets.filter((t) => t.path.endsWith(".h"));
  const rest = targets.filter((t) => !t.path.endsWith(".h"));
  for (const t of headers) result[t.path] = await writeFile({ provider, tier, prompt, plan, target: t, files: result, instructions: t.instructions, log });
  const snapshot = { ...result };
  const written = await mapLimit(rest, WRITER_CONCURRENCY, (t) =>
    writeFile({ provider, tier, prompt, plan, target: t, files: snapshot, instructions: t.instructions, log }));
  rest.forEach((t, i) => (result[t.path] = written[i]));
  return result;
}

async function architect({ provider, tier, prompt, baseFiles, maxFiles, changeRequest, log }) {
  log("architect", changeRequest ? "Planning the change across the existing files..." : `Planning the OS (up to ${maxFiles} files)...`);
  const res = await provider.complete({
    system: prompts.architectSystem(tier, maxFiles),
    content: prompts.architectUser({ prompt, fileIndex: fileIndex(baseFiles), sdkHeader: baseFiles["kc.h"], changeRequest }),
    effort: "high",
    maxTokens: 32000,
  });
  let plan;
  try {
    plan = prompts.parseTagged(res.text, "plan");
  } catch {
    throw new Error("Architect returned an unreadable plan");
  }
  const files = (Array.isArray(plan.files) ? plan.files : [])
    .filter((f) => validPlanPath(f.path, tier))
    .slice(0, maxFiles)
    .map((f) => ({ path: f.path, action: baseFiles[f.path] != null ? "modify" : "create", purpose: String(f.purpose || "") }));
  if (!files.length) throw new Error("Architect planned no files");
  plan.files = files;
  log("architect", `${plan.name || "OS"}: ${plan.summary || ""}\nFiles: ${files.map((f) => `${f.path}${f.action === "modify" ? " (modify)" : ""}`).join(", ")}`);
  return plan;
}

async function generate({ provider, tier, prompt, baseFiles, maxFiles, changeRequest, emit }) {
  const log = (agent, message) => emit({ type: "log", agent, message });
  const plan = await architect({ provider, tier, prompt, baseFiles, maxFiles, changeRequest, log });
  log("writer", `Writing ${plan.files.length} files with ${WRITER_CONCURRENCY} parallel writers...`);
  const files = await writePlanned({ provider, tier, prompt, plan, files: baseFiles, targets: plan.files, log });
  return { files, plan, notes: plan.summary || "" };
}

// Maps compiler errors to files; falls back to the fixer agent for link
// errors and visual problems.
async function repair({ provider, tier, prompt, plan, files, problem, kind, emit }) {
  const log = (agent, message) => emit({ type: "log", agent, message });
  let targets = [];
  if (kind === "build") {
    const byFile = {};
    for (const m of problem.matchAll(/^([A-Za-z0-9_./-]+\.(?:c|h|asm|inc)):(\d+)(?::\d+)?:\s*(?:fatal )?error:.*$/gm)) {
      if (files[m[1]] == null) continue;
      (byFile[m[1]] ||= []).push(m[0]);
    }
    targets = Object.entries(byFile).slice(0, 6).map(([path, errs]) => ({
      path,
      purpose: plan?.files.find((f) => f.path === path)?.purpose || "existing file",
      instructions: `Compiler errors:\n${errs.slice(0, 30).join("\n")}`,
    }));
  }
  if (!targets.length) {
    log("fixer", "Deciding which files to rewrite...");
    const res = await provider.complete({
      system: prompts.fixerSystem(tier),
      content: prompts.fixerUser({ prompt, fileIndex: fileIndex(files), problem, headers: headersOf(files) }),
      effort: "high",
      maxTokens: 16000,
    });
    let fixes = [];
    try { fixes = prompts.parseTagged(res.text, "fixes"); } catch {}
    targets = (Array.isArray(fixes) ? fixes : [])
      .filter((f) => validPlanPath(f.path, tier) || f.path === "boot.asm")
      .slice(0, 6)
      .map((f) => ({ path: f.path, purpose: plan?.files.find((p) => p.path === f.path)?.purpose || "existing file", instructions: String(f.instructions || problem) }));
  }
  if (!targets.length) throw new Error("No files were chosen for repair");
  log("fixer", `Rewriting ${targets.map((t) => t.path).join(", ")}`);
  const repaired = await writePlanned({ provider, tier, prompt, plan: plan || { files: targets }, files, targets, log });
  return { files: repaired };
}

module.exports = { generate, repair, fileIndex };
