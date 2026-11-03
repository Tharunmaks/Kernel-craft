// Accuracy mode: research -> generate -> boot/test -> compare -> improve.
//
// 1. Research: the model turns the request into a weighted, checkable spec
//    (visual requirements seen on the first screenshot, code requirements
//    read from the source).
// 2. Generate + test: lib/pipeline.js builds, boots and repairs the OS.
// 3. Compare: judges score every requirement 0 / 0.5 / 1 against the
//    screenshot and the source. Score = weighted average, 0..100.
// 4. Improve: the unmet requirements become a change request on the best
//    build so far. Repeat until the score reaches the target or rounds run out.
//
// The score measures how closely the build matches its own spec, as judged
// by a model. It is not a measure of parity with a commercial OS.
const prompts = require("./prompts");
const { buildOS } = require("./pipeline");

const CODE_BUDGET = 160 * 1024; // characters of source sent to the code judge
const MAX_FIX_ITEMS = 10;

const image = (png) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });

function visionCall(provider) {
  if (typeof provider.see === "function") return provider.see;
  return ({ system, text, png, maxTokens }) => provider.complete({ system, content: [image(png), { type: "text", text }], maxTokens });
}

function normalizeSpec(raw, prompt) {
  const reqs = (Array.isArray(raw?.requirements) ? raw.requirements : [])
    .filter((r) => r && typeof r.text === "string" && r.text.trim())
    .slice(0, 24)
    .map((r, i) => ({
      id: `R${i + 1}`,
      kind: r.kind === "code" ? "code" : "visual",
      weight: [1, 2, 3].includes(Number(r.weight)) ? Number(r.weight) : 2,
      text: r.text.trim().slice(0, 400),
    }));
  if (reqs.length < 3) throw new Error("Research agent returned too few requirements");
  return {
    name: String(raw.name || "").trim().slice(0, 40) || prompt.slice(0, 40),
    summary: String(raw.summary || "").trim().slice(0, 800),
    style: String(raw.style || "").trim().slice(0, 800),
    requirements: reqs,
  };
}

async function research({ provider, tier, prompt }) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await provider.complete({ system: prompts.researchSystem(tier), content: `User request:\n${prompt}`, maxTokens: 6000 });
    try { return normalizeSpec(prompts.parseTagged(res.text, "spec"), prompt); } catch (err) { lastErr = err; }
  }
  throw new Error(`Research failed: ${lastErr.message}`);
}

// Fit the source into the judge's budget: small files whole, big ones trimmed.
function sourceForJudge(files) {
  const entries = Object.entries(files || {}).filter(([, src]) => typeof src === "string");
  const total = entries.reduce((n, [, s]) => n + s.length, 0);
  if (total <= CODE_BUDGET) return Object.fromEntries(entries);
  const share = Math.floor(CODE_BUDGET / entries.length);
  return Object.fromEntries(entries.map(([n, s]) => [n, s.length > share ? `${s.slice(0, share)}\n/* ... ${s.length - share} more characters ... */` : s]));
}

function parseScores(text, requirements) {
  let raw = [];
  try { raw = prompts.parseTagged(text, "scores").scores || []; } catch { raw = []; }
  const byId = new Map(raw.map((s) => [String(s.id), s]));
  return requirements.map((r) => {
    const s = byId.get(r.id);
    const score = s ? Math.max(0, Math.min(1, Math.round(Number(s.score) * 2) / 2 || 0)) : 0;
    return { ...r, score, evidence: String(s?.evidence || (s ? "" : "not scored by the judge")).slice(0, 400), fix: String(s?.fix || "").slice(0, 600) };
  });
}

// Score one build against the spec. Hard gates first: a build that did not
// boot to a picture scores 0 on every visual requirement.
async function score({ provider, tier, prompt, spec, record }) {
  const visual = spec.requirements.filter((r) => r.kind === "visual");
  const code = spec.requirements.filter((r) => r.kind === "code");
  const booted = Boolean(record?.png && !record.stats?.blank && record.stage === "boot");
  const see = visionCall(provider);

  const [visualScores, codeScores] = await Promise.all([
    visual.length && booted
      ? see({ system: prompts.judgeVisualSystem(tier), text: prompts.judgeUser({ prompt, spec, requirements: visual }), png: record.png, maxTokens: 6000 })
        .then((res) => parseScores(res.text, visual))
      : Promise.resolve(visual.map((r) => ({ ...r, score: 0, evidence: "The OS did not boot to a screen.", fix: "Make the OS boot and draw its UI." }))),
    code.length && record?.files
      ? provider.complete({ system: prompts.judgeCodeSystem(tier), content: prompts.judgeUser({ prompt, spec, requirements: code, files: sourceForJudge(record.files) }), maxTokens: 6000 })
        .then((res) => parseScores(res.text, code))
      : Promise.resolve(code.map((r) => ({ ...r, score: 0, evidence: "No source", fix: "" }))),
  ]);

  const items = [...visualScores, ...codeScores].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const total = items.reduce((n, r) => n + r.weight, 0);
  const got = items.reduce((n, r) => n + r.weight * r.score, 0);
  // A build the pipeline could not verify (crash, panic, blank) is capped.
  let percent = total ? (100 * got) / total : 0;
  if (!record?.verdict?.pass) percent = Math.min(percent, 60);
  return { percent: Math.round(percent * 10) / 10, items, booted };
}

function changeRequestFrom(card) {
  const misses = card.items.filter((r) => r.score < 1).sort((a, b) => b.weight * (1 - b.score) - a.weight * (1 - a.score)).slice(0, MAX_FIX_ITEMS);
  return `The build scored ${card.percent}% against the specification. Improve it so every requirement is fully met, without breaking what already works. Unmet requirements, most important first:
${misses.map((r) => `- ${r.id} (${r.kind}, weight ${r.weight}, scored ${r.score}): ${r.text}\n  Judge saw: ${r.evidence}${r.fix ? `\n  Needed: ${r.fix}` : ""}`).join("\n")}`;
}

async function evolveOS({
  prompt,
  tier,
  provider,
  targetPercent = 95,
  maxRounds = 5,
  emit = () => {},
  ...buildOptions // maxPasses, bigFiles, baseFiles, changeRequest, extraFiles, hardware
}) {
  const log = (agent, message) => emit({ type: "log", agent, message });
  if (typeof provider.complete !== "function") {
    log("system", "Accuracy mode needs an AI provider; building once without scoring.");
    return buildOS({ prompt, tier, provider, emit, ...buildOptions });
  }

  log("research", `Researching "${prompt.slice(0, 120)}" and writing a scored specification...`);
  const spec = await research({ provider, tier, prompt });
  log("research", `${spec.name}: ${spec.requirements.length} requirements (${spec.requirements.filter((r) => r.kind === "visual").length} visual, ${spec.requirements.filter((r) => r.kind === "code").length} code). Target ${targetPercent}%.\n${spec.requirements.map((r) => `${r.id} [${r.kind}, w${r.weight}] ${r.text}`).join("\n")}`);
  emit({ type: "spec", spec, targetPercent });

  const specPrompt = `${prompt}\n\n${prompts.specText(spec)}`;
  const allPasses = [];
  const rounds = [];
  let best = null;      // { result, card }
  let lastResult = null;
  let changeRequest = buildOptions.changeRequest || null;
  let baseFiles = buildOptions.baseFiles || null;

  for (let round = 1; round <= maxRounds; round++) {
    log("system", round === 1 ? "Round 1: generating, building and booting." : `Round ${round}: improving the best build (${best ? `${best.card.percent}%` : "none yet"}).`);
    const offset = allPasses.length;
    let result;
    try {
      result = await buildOS({
        ...buildOptions,
        prompt: specPrompt,
        tier,
        provider,
        baseFiles,
        changeRequest,
        emit: (ev) => emit(ev.type === "pass" ? { ...ev, pass: ev.pass + offset, round } : ev),
      });
    } catch (err) {
      // One failed round (a model error, a bad plan) should not end the run.
      if (err.fatal || /API_KEY|401|403|User not found|credits/i.test(err.message)) throw err;
      log("system", `Round ${round} failed: ${err.message}`);
      rounds.push({ round, percent: 0, error: err.message });
      continue;
    }
    for (const p of result.passes) { p.pass += offset; p.round = round; allPasses.push(p); }
    lastResult = result;

    if (!result.final) {
      log("judge", `Round ${round}: no bootable build to score.`);
      rounds.push({ round, percent: 0 });
      changeRequest = "The previous attempt never produced a bootable build. Keep the boot path from the files you were given and add the specification's features carefully.";
      continue;
    }

    log("judge", "Comparing the build with the specification (screenshot + source)...");
    const card = await score({ provider, tier, prompt, spec, record: result.final });
    rounds.push({ round, percent: card.percent, pass: result.final.pass });
    emit({ type: "score", round, percent: card.percent, targetPercent, items: card.items, pass: result.final.pass });
    log("judge", `Round ${round}: ${card.percent}% (target ${targetPercent}%).\n${card.items.map((r) => `${r.score === 1 ? "✓" : r.score ? "½" : "✗"} ${r.id} ${r.text}`).join("\n")}`);

    if (!best || card.percent > best.card.percent) best = { result, card };
    if (best.card.percent >= targetPercent) break;
    if (round < maxRounds) {
      baseFiles = best.result.final.files;
      changeRequest = changeRequestFrom(best.card);
    }
  }

  const chosen = best?.result || lastResult;
  const reached = Boolean(best && best.card.percent >= targetPercent);
  log("system", best
    ? `${reached ? "Reached" : "Stopped below"} the target: best score ${best.card.percent}% after ${rounds.length} round(s).`
    : `No round produced a bootable build after ${rounds.length} round(s).`);

  return {
    ...chosen,
    passes: allPasses,
    accuracy: { spec, targetPercent, reached, percent: best?.card.percent ?? 0, items: best?.card.items ?? [], rounds },
  };
}

module.exports = { evolveOS, research, score, changeRequestFrom, normalizeSpec };
