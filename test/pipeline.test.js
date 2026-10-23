// Run with: npm test   (needs nasm, gcc with -m32 support, ld, qemu-system-i386/x86_64)
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const Anthropic = require("@anthropic-ai/sdk");
const { TIERS, getTier } = require("../lib/tiers");
const { buildOS } = require("../lib/pipeline");
const { readTemplate, validateSources } = require("../lib/toolchain");
const { parseFiles, parseVerdict } = require("../lib/prompts");
const { createOfflineProvider } = require("../lib/providers/offline");
const { createAnthropicProvider } = require("../lib/providers/anthropic");

for (const tier of Object.values(TIERS)) {
  test(`${tier.id} template builds, boots and draws something`, async () => {
    const result = await buildOS({ prompt: "an OS called TestOS", tier, provider: createOfflineProvider(), maxPasses: 1 });
    assert.ok(result.verified, JSON.stringify(result.passes[0].verdict));
    assert.strictEqual(result.final.image.length, 1474560);
    assert.ok(!result.final.stats.blank);
  });
}

test("build errors and blank screens are fed back to the generator", async () => {
  const tier = getTier("real16");
  const template = await readTemplate(tier);
  const seen = [];
  const provider = {
    describe: () => "scripted",
    async generate({ pass, feedback }) {
      seen.push(feedback);
      if (pass === 1) return { files: { ...template, "kernel.asm": "[org 0x8000]\n mov ax, \n" }, notes: "broken" };
      if (pass === 2) return { files: { ...template, "kernel.asm": "[org 0x8000]\n mov ax, 0x0013\n int 0x10\n cli\n hlt\n" }, notes: "blank" };
      return { files: template, notes: "fixed" };
    },
    async critique() {
      return { pass: true, summary: "looks right", issues: [] };
    },
  };
  const result = await buildOS({ prompt: "x", tier, provider, maxPasses: 3 });
  assert.ok(result.verified);
  assert.strictEqual(result.final.pass, 3);
  assert.match(seen[1], /build failed/i);
  assert.match(seen[2], /nothing was drawn/i);
});

test("sources cannot read host files", () => {
  assert.ok(validateSources({ "kernel.asm": 'incbin "/etc/passwd"' }).length);
  assert.ok(validateSources({ "kernel.c": '#include "../secret.h"' }).length);
  assert.ok(validateSources({ "kernel.c": 'asm(".include \\"x\\"");' }).length);
  assert.ok(validateSources({ "../boot.asm": "" }).length);
  assert.deepStrictEqual(validateSources({ "kernel.c": '#include "util.h"' }), []);
});

test("parsers", () => {
  const { files, notes } = parseFiles('<file name="a.asm">\nnop\n</file>\n<file name="b.c">\nint x;\n</file>\n<notes>did it</notes>');
  assert.deepStrictEqual(files, { "a.asm": "nop\n", "b.c": "int x;\n" });
  assert.strictEqual(notes, "did it");
  assert.deepStrictEqual(parseVerdict('<verdict>{"pass": false, "summary": "s", "issues": ["i"]}</verdict>'), { pass: false, summary: "s", issues: ["i"] });
  assert.strictEqual(parseVerdict("garbage").pass, false);
});

test("anthropic provider sends a well-formed streaming request", async () => {
  const requests = [];
  const reply = '<file name="boot.asm">\nnop\n</file>\n<notes>ok</notes>';
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const client = new Anthropic({ apiKey: "test", baseURL: `http://127.0.0.1:${server.address().port}` });
    const provider = createAnthropicProvider({ client });
    const out = await provider.generate({ prompt: "p", tier: getTier("prot32"), templateFiles: { "boot.asm": "x" } });
    assert.deepStrictEqual(out.files, { "boot.asm": "nop\n" });
    const { headers, body } = requests[0];
    assert.strictEqual(body.model, "claude-opus-5-5");
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.fallbacks, "default");
    assert.deepStrictEqual(body.thinking, { type: "adaptive" });
    assert.match(headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  } finally {
    server.close();
  }
});
