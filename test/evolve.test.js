// Accuracy mode and the OpenRouter provider, with scripted models (no network).
const test = require("node:test");
const assert = require("node:assert");
const prompts = require("../lib/prompts");
const { getTier } = require("../lib/tiers");
const { readTemplate } = require("../lib/toolchain");
const { evolveOS, changeRequestFrom } = require("../lib/evolve");
const { createOpenRouterProvider } = require("../lib/providers/openrouter");

const SPEC = {
  name: "Acme OS",
  summary: "A company desktop.",
  style: "red and white",
  requirements: [
    { id: "R1", kind: "visual", weight: 3, text: "Red desktop with an Acme logo" },
    { id: "R2", kind: "visual", weight: 2, text: "Taskbar at the bottom" },
    { id: "R3", kind: "code", weight: 3, text: "Login screen with hashed passwords" },
  ],
};

test("accuracy mode: research, build, score, improve until the target", { timeout: 120000 }, async () => {
  const tier = getTier("real16");
  const template = await readTemplate(tier);
  const calls = { research: 0, visual: 0, code: 0, generate: [] };
  // Round 1 meets R2 only; round 2 meets everything.
  const scoreFor = (round, ids) => `<scores>${JSON.stringify({ scores: ids.map((id) => ({ id, score: round > 1 || id === "R2" ? 1 : 0, evidence: "seen", fix: "do it" })) })}</scores>`;
  const provider = {
    describe: () => "scripted",
    async complete({ system }) {
      if (system === prompts.researchSystem(tier)) { calls.research++; return { text: `<spec>${JSON.stringify(SPEC)}</spec>` }; }
      if (system === prompts.judgeCodeSystem(tier)) { calls.code++; return { text: scoreFor(calls.code, ["R3"]) }; }
      throw new Error("unexpected complete() call");
    },
    async see({ system, png }) {
      assert.strictEqual(system, prompts.judgeVisualSystem(tier));
      assert.ok(png.length > 100);
      calls.visual++;
      return { text: scoreFor(calls.visual, ["R1", "R2"]) };
    },
    async generate({ prompt, previousFiles, feedback }) {
      calls.generate.push({ prompt, previous: Boolean(previousFiles), feedback });
      return { files: previousFiles || template, notes: "" };
    },
    async critique() { return { pass: true, summary: "ok", issues: [] }; },
  };
  const events = [];
  const result = await evolveOS({ prompt: "an OS for Acme", tier, provider, maxPasses: 1, maxRounds: 4, emit: (e) => events.push(e) });

  assert.strictEqual(calls.research, 1);
  assert.strictEqual(result.accuracy.rounds.length, 2);
  assert.deepStrictEqual(result.accuracy.rounds.map((r) => r.percent), [25, 100]);
  assert.ok(result.accuracy.reached);
  assert.match(calls.generate[0].prompt, /R3 \[code, weight 3\] Login screen/);
  assert.ok(calls.generate[1].previous);
  assert.match(calls.generate[1].feedback, /scored 25%/);
  assert.match(calls.generate[1].feedback, /R1 .*Red desktop/);
  assert.doesNotMatch(calls.generate[1].feedback, /R2 /);
  // Pass numbers keep counting across rounds.
  assert.deepStrictEqual(result.passes.map((p) => p.pass), [1, 2]);
  assert.deepStrictEqual(events.filter((e) => e.type === "score").map((e) => e.percent), [25, 100]);
});

test("accuracy mode stops at the round cap and keeps the best build", { timeout: 120000 }, async () => {
  const tier = getTier("real16");
  const template = await readTemplate(tier);
  let judged = 0;
  const half = (ids) => ({ text: `<scores>${JSON.stringify({ scores: ids.map((id) => ({ id, score: judged === 1 ? 0.5 : 0 })) })}</scores>` });
  const provider = {
    describe: () => "scripted",
    async complete({ system }) {
      if (system === prompts.researchSystem(tier)) return { text: `<spec>${JSON.stringify(SPEC)}</spec>` };
      return half(["R3"]);
    },
    async see() { judged++; return half(["R1", "R2"]); },
    async generate({ previousFiles }) { return { files: previousFiles || template, notes: "" }; },
    async critique() { return { pass: true, summary: "ok", issues: [] }; },
  };
  const result = await evolveOS({ prompt: "x", tier, provider, maxPasses: 1, maxRounds: 3 });
  assert.strictEqual(result.accuracy.rounds.length, 3);
  assert.strictEqual(result.accuracy.percent, 50);
  assert.ok(!result.accuracy.reached);
  assert.strictEqual(result.final.round, 1);
});

test("unmet requirements become a prioritised change request", () => {
  const text = changeRequestFrom({
    percent: 40,
    items: [
      { id: "R1", kind: "visual", weight: 1, text: "small", score: 0, evidence: "", fix: "" },
      { id: "R2", kind: "code", weight: 3, text: "big", score: 0, evidence: "missing", fix: "add it" },
      { id: "R3", kind: "visual", weight: 3, text: "done", score: 1, evidence: "", fix: "" },
    ],
  });
  assert.ok(text.indexOf("R2") < text.indexOf("R1"));
  assert.doesNotMatch(text, /R3/);
  assert.match(text, /Needed: add it/);
});

test("OpenRouter: sends the key as a bearer token and falls back to the next model", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, model: body.model, auth: init.headers.Authorization });
    const json = body.model === "a:free"
      ? { error: { code: 404, message: "No endpoints found for a:free" } }
      : { model: body.model, choices: [{ message: { content: '<file name="kernel.asm">\n[org 0x8000]\n</file>' }, finish_reason: "stop" }] };
    return { ok: body.model !== "a:free", status: body.model === "a:free" ? 404 : 200, headers: { get: () => null }, json: async () => json };
  };
  const provider = createOpenRouterProvider({ apiKey: "test-key", models: ["a:free", "b:free"], criticModels: ["v:free"], fetchImpl, sleep: async () => {} });
  const out = await provider.generate({ prompt: "x", tier: getTier("real16"), templateFiles: {}, pass: 0 });
  assert.deepStrictEqual(Object.keys(out.files), ["kernel.asm"]);
  assert.deepStrictEqual(seen.map((s) => s.model), ["a:free", "b:free"]);
  assert.ok(seen.every((s) => s.auth === "Bearer test-key" && s.url === "https://openrouter.ai/api/v1/chat/completions"));
  // The working model is remembered for the next call.
  await provider.complete({ system: "s", content: "c" });
  assert.strictEqual(seen.at(-1).model, "b:free");
  assert.match(provider.describe(), /b:free/);
});

test("OpenRouter: a bad key is not retried on other models", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: { code: 401, message: "User not found." } }) }; };
  const provider = createOpenRouterProvider({ apiKey: "bad", models: ["a", "b"], fetchImpl, sleep: async () => {} });
  await assert.rejects(provider.complete({ system: "s", content: "c" }), /User not found/);
  assert.strictEqual(calls, 1);
});

test("OpenRouter: the daily free-model limit stops at once with a clear message", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: { code: 429, message: "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day" } }) }; };
  const provider = createOpenRouterProvider({ apiKey: "k", models: ["a", "b"], fetchImpl, sleep: async () => {} });
  await assert.rejects(provider.complete({ system: "s", content: "c" }), (err) => err.fatal && /daily free-model limit/.test(err.message));
  assert.strictEqual(calls, 1);
});
