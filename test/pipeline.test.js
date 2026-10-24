// Run with: npm test   (needs nasm, gcc with -m32 support, ld, qemu-system-i386/x86_64;
// the Linux Forge test also needs "npm run setup:linux")
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const Anthropic = require("@anthropic-ai/sdk");
const { TARGETS, getTier } = require("../lib/tiers");
const { buildOS } = require("../lib/pipeline");
const { readTemplate, validateSources } = require("../lib/toolchain");
const prompts = require("../lib/prompts");
const { createOfflineProvider } = require("../lib/providers/offline");
const { createAnthropicProvider } = require("../lib/providers/anthropic");

const linuxReady = fs.existsSync(path.join(TARGETS.linux64.linuxBase, "vmlinuz"));

for (const tier of Object.values(TARGETS)) {
  const skip = tier.builder === "linux" && !linuxReady && "Linux base not installed (npm run setup:linux)";
  test(`${tier.id}: offline build boots and draws something`, { skip, timeout: 120000 }, async () => {
    const result = await buildOS({ prompt: "an OS called TestOS", tier, provider: createOfflineProvider(), maxPasses: 1 });
    assert.ok(result.verified, JSON.stringify(result.passes[0].verdict));
    assert.ok(!result.final.stats.blank);
    if (tier.builder === "floppy") assert.strictEqual(result.final.artifacts["floppy.img"].length, 1474560);
    else assert.ok(result.final.artifacts["forge.tar.gz"].length > 1000);
  });
}

test("build errors and blank screens are fed back to the generator", { timeout: 60000 }, async () => {
  const tier = getTier("real16");
  const template = await readTemplate(tier);
  const seen = [];
  const provider = {
    describe: () => "scripted",
    async generate({ pass, feedback }) {
      seen.push(feedback);
      if (pass === 0) return { files: { ...template, "kernel.asm": "[org 0x8000]\n mov ax, \n" }, notes: "broken" };
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

test("big mode: architect plans, writers write, compile errors are repaired", { timeout: 120000 }, async () => {
  const tier = getTier("prot32");
  const good = '/* Hello app */\n#include "kc.h"\nstatic void hello_open(void) { wm_create("Hello", -1, -1, 300, 200); }\nKC_APP(hello, "Hello", icon_info, hello_open);\n';
  const calls = { architect: 0, writer: 0 };
  const provider = {
    describe: () => "scripted",
    async complete({ system }) {
      if (system === prompts.architectSystem(tier, 10)) {
        calls.architect++;
        return { text: '<plan>{"name":"HelloOS","summary":"adds an app","files":[{"path":"hello.c","purpose":"hello app"},{"path":"../evil.c","purpose":"x"}]}</plan>' };
      }
      calls.writer++;
      const src = calls.writer === 1 ? "/* broken */\nint x = ;\n" : good;
      return { text: `<file name="hello.c">\n${src}</file>` };
    },
    async critique() { return { pass: true, summary: "ok", issues: [] }; },
  };
  const result = await buildOS({ prompt: "an OS called HelloOS", tier, provider, maxPasses: 1, bigFiles: 10 });
  assert.ok(result.verified, JSON.stringify(result.passes.map((p) => p.verdict)));
  assert.strictEqual(calls.architect, 1);
  assert.strictEqual(calls.writer, 2, "broken file rewritten once");
  assert.deepStrictEqual(result.plan.files.map((f) => f.path), ["hello.c"], "unsafe paths dropped from the plan");
  assert.strictEqual(result.final.files["hello.c"], good);
  assert.ok(result.final.files["kc.h"], "SDK kept");
});

test("sources cannot read host files", () => {
  assert.ok(validateSources({ "kernel.asm": 'incbin "/etc/passwd"' }).length);
  assert.ok(validateSources({ "kernel.c": '#include "../secret.h"' }).length);
  assert.ok(validateSources({ "kernel.c": 'asm(".include \\"x\\"");' }).length);
  assert.ok(validateSources({ "kernel.c": "#include <stdio.h>" }).length, "no system headers when freestanding");
  assert.ok(validateSources({ "../boot.asm": "" }).length);
  assert.deepStrictEqual(validateSources({ "kernel.c": '#include "util.h"' }), []);

  const linux = getTier("linux64");
  assert.deepStrictEqual(validateSources({ "rootfs/etc/motd": "hi", "src/app.c": "#include <stdio.h>\n" }, linux), []);
  assert.ok(validateSources({ "etc/passwd": "" }, linux).length);
  assert.ok(validateSources({ "rootfs/../x": "" }, linux).length);
  assert.ok(validateSources({ "src/a/b.c": "" }, linux).length);
  assert.ok(validateSources({ "src/app.c": "#include </etc/shadow>" }, linux).length);
});

test("parsers", () => {
  const { files, notes } = prompts.parseFiles('<file name="a.asm">\nnop\n</file>\n<file name="b.c">\nint x;\n</file>\n<notes>did it</notes>');
  assert.deepStrictEqual(files, { "a.asm": "nop\n", "b.c": "int x;\n" });
  assert.strictEqual(notes, "did it");
  assert.deepStrictEqual(prompts.parseVerdict('<verdict>{"pass": false, "summary": "s", "issues": ["i"]}</verdict>'), { pass: false, summary: "s", issues: ["i"] });
  assert.strictEqual(prompts.parseVerdict("garbage").pass, false);
  assert.deepStrictEqual(prompts.parseTagged('x <fixes>[{"path":"a.c"}]</fixes>', "fixes"), [{ path: "a.c" }]);
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
    const big = await provider.complete({ system: "s", content: "c", effort: "medium", maxTokens: 1000 });
    assert.match(big.text, /nop/);
    const { headers, body } = requests[0];
    assert.strictEqual(body.model, "claude-opus-5-5");
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.fallbacks, "default");
    assert.deepStrictEqual(body.thinking, { type: "adaptive" });
    assert.deepStrictEqual(requests[1].body.output_config, { effort: "medium" });
    assert.match(headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  } finally {
    server.close();
  }
});

test("hardware settings are validated and reach QEMU and the kernel", () => {
  const hardware = require("../lib/hardware");
  const prot32 = getTier("prot32");
  const { hw, notes } = hardware.normalize({ resolution: "1920x1080", vramMB: 8, ramMB: 32, cpus: 64, cpuModel: "evil" }, prot32);
  assert.ok(hw.vramMB * 1048576 >= 1920 * 1080 * 4, "framebuffer fits in graphics memory");
  assert.ok(hw.ramMB >= 64, "RAM raised for the back buffers");
  assert.strictEqual(hw.cpus, 1, "unsupported core count falls back");
  assert.strictEqual(hw.cpuModel, "basic");
  assert.ok(notes.some((n) => /RAM raised/.test(n)));
  assert.strictEqual(hardware.normalize({ resolution: "1920x1080", vramMB: 8 }, prot32).hw.vramMB, 8);
  const args = hardware.qemuArgs({ ...hw, cpus: 4 }, prot32).join(" ");
  assert.match(args, /-m \d+ -smp 4 -cpu qemu32 -vga none -device VGA,vgamem_mb=8/);
  assert.match(hardware.configSource(hw), /kc_hw = \{ 1920, 1080,/);
  assert.strictEqual(hardware.normalize({ resolution: "1920x1080", vramMB: 8 }, prot32).hw.vramMB, 8);
  const linux = hardware.normalize({ resolution: "1920x1080" }, getTier("linux64")).hw;
  assert.strictEqual(linux.resolution, "1280x1024", "Linux falls back to a VESA mode");
  assert.match(hardware.linuxCmdline(linux), /vga=0x31b/);
});

for (const target of ["prot32", "long64"]) {
  test(`${target}: every catalog app builds and registers at a custom resolution`, { timeout: 120000 }, async () => {
    const apps = require("../lib/apps");
    const tier = getTier(target);
    const extraFiles = apps.filesFor(apps.list().map((a) => a.id), tier);
    const result = await buildOS({ prompt: "an OS called AppOS", tier, provider: createOfflineProvider(), maxPasses: 1, extraFiles, hardware: { resolution: "1024x768", cpus: 2, ramMB: 128 } });
    assert.ok(result.verified, JSON.stringify(result.passes[0].verdict));
    assert.match(result.final.serialLog, /gfx: 1024x768x32/);
    assert.match(result.final.serialLog, new RegExp(`wm: ${6 + apps.list().length} apps registered`));
    assert.ok(result.final.files["app_browser.c"]);
    assert.ok(!result.final.files["kc_config.c"], "engine config is not saved as a project file");
  });
}

test("apps are only offered for SDK targets", () => {
  const apps = require("../lib/apps");
  assert.throws(() => apps.filesFor(["paint"], getTier("real16")), /32-bit or 64-bit/);
  assert.throws(() => apps.filesFor(["../../etc/passwd"], getTier("prot32")), /Unknown app/);
});

test("big RAM and graphics memory: capped for the test VM, full in exports", () => {
  const hardware = require("../lib/hardware");
  const tier = getTier("long64");
  const { hw } = hardware.normalize({ ramMB: 24576, vramMB: 6144, resolution: "1920x1080", cpus: 8 }, tier);
  assert.strictEqual(hw.ramMB, 24576);
  assert.strictEqual(hw.vramMB, 6144);
  assert.match(hardware.qemuArgs(hw, tier).join(" "), /-m 24576 .*vgamem_mb=512/);
  assert.match(hardware.qemuArgs(hw, tier, { test: true }).join(" "), /-m 4096 /);
  const notes = hardware.limitNotes(hw, tier).join(" ");
  assert.match(notes, /test VM uses 4 GB/);
  assert.match(notes, /up to 512 MB/);
});

test("samples include the showcase OS with every app", { timeout: 60000 }, async () => {
  const { buildSample } = require("../lib/samples");
  const image = await buildSample("showcase");
  assert.strictEqual(image.length, 1474560);
  await assert.rejects(buildSample("../x"), /Unknown sample/);
});
