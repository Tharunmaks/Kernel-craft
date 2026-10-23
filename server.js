// KernelCraft build & verification engine.
//
//   POST /api/build-os  { prompt, tier, maxPasses? }
//     Streams NDJSON events ({type:"log"|"pass"|"result"|"error"}) unless the
//     client sends "Accept: application/json", in which case it waits and
//     returns the final result as one JSON object.
//   GET  /api/sample/:tier.img   Builds the stock template for a tier (no LLM).
//   GET  /api/config             Provider and tier info for the frontend.
//
// Static: public/ (IDE), /vendor/* (v86 emulator + BIOS images).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { TIERS, getTier } = require("./lib/tiers");
const { createProvider } = require("./lib/providers");
const { buildOS } = require("./lib/pipeline");
const { buildImage, makeWorkDir, readTemplate } = require("./lib/toolchain");

const PORT = Number(process.env.PORT) || 8086;
const MAX_PASSES = 3;
const MAX_CONCURRENT_BUILDS = Number(process.env.KC_MAX_BUILDS) || 2;
const BOOT_WAIT_MS = Number(process.env.KC_BOOT_WAIT_MS) || 3000;

const provider = createProvider();

const STATIC = {
  "/vendor/libv86.js": path.join(__dirname, "node_modules/v86/build/libv86.js"),
  "/vendor/v86.wasm": path.join(__dirname, "node_modules/v86/build/v86.wasm"),
  "/vendor/bios/seabios.bin": path.join(__dirname, "vendor/bios/seabios.bin"),
  "/vendor/bios/vgabios.bin": path.join(__dirname, "vendor/bios/vgabios.bin"),
};
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".svg": "image/svg+xml",
};

// Each build runs compilers and a VM, so cap how many run at once.
let activeBuilds = 0;
const waiting = [];
async function withBuildSlot(fn) {
  if (activeBuilds >= MAX_CONCURRENT_BUILDS) await new Promise((r) => waiting.push(r));
  activeBuilds++;
  try {
    return await fn();
  } finally {
    activeBuilds--;
    waiting.shift()?.();
  }
}

function sendJSON(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function serveFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJSON(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Content-Length": st.size });
    fs.createReadStream(file).pipe(res);
  });
}

function serializePass(p) {
  return {
    pass: p.pass,
    stage: p.stage,
    verdict: p.verdict,
    stats: p.stats,
    screenshot: p.png ? `data:image/png;base64,${p.png.toString("base64")}` : null,
  };
}

async function handleBuild(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJSON(res, 400, { error: "Body must be JSON: { prompt, tier }" });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > 4000) return sendJSON(res, 400, { error: "prompt must be 1-4000 characters" });
  let tier;
  try {
    tier = getTier(body.tier || "real16");
  } catch (err) {
    return sendJSON(res, 400, { error: err.message });
  }
  const maxPasses = Math.min(MAX_PASSES, Math.max(1, Number(body.maxPasses) || MAX_PASSES));
  const streaming = !(req.headers.accept || "").includes("application/json");

  if (streaming) res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  const emit = (event) => streaming && !res.writableEnded && res.write(JSON.stringify(event) + "\n");
  if (activeBuilds >= MAX_CONCURRENT_BUILDS) emit({ type: "log", agent: "system", message: "Waiting for a free build slot..." });

  try {
    const result = await withBuildSlot(() => buildOS({ prompt, tier, provider, maxPasses, bootWaitMs: BOOT_WAIT_MS, emit }));
    const payload = {
      type: "result",
      verified: result.verified,
      tier: tier.id,
      browserBootable: tier.browserBootable,
      finalPass: result.final?.pass ?? null,
      image: result.final?.image ? result.final.image.toString("base64") : null,
      files: result.final?.files ?? null,
      passes: result.passes.map(serializePass),
    };
    if (streaming) {
      // Screenshots were already streamed per pass; don't send them twice.
      payload.passes = payload.passes.map(({ screenshot, ...rest }) => rest);
      res.end(JSON.stringify(payload) + "\n");
    } else {
      sendJSON(res, 200, payload);
    }
  } catch (err) {
    console.error("build-os failed:", err);
    if (streaming) res.end(JSON.stringify({ type: "error", message: err.message }) + "\n");
    else sendJSON(res, 500, { error: err.message });
  }
}

async function handleSample(res, tierName) {
  let tier;
  try {
    tier = getTier(tierName);
  } catch (err) {
    return sendJSON(res, 404, { error: err.message });
  }
  const workDir = await makeWorkDir();
  try {
    const { image } = await withBuildSlot(async () => buildImage(await readTemplate(tier), tier, workDir));
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="kernelcraft-${tier.id}.img"`,
      "Content-Length": image.length,
    });
    res.end(image);
  } catch (err) {
    sendJSON(res, 500, { error: err.message, log: err.log });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }, () => {});
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/api/build-os") return handleBuild(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") return sendJSON(res, 405, { error: "Method not allowed" });

  if (url.pathname === "/api/config") {
    return sendJSON(res, 200, {
      provider: provider.describe(),
      maxPasses: MAX_PASSES,
      tiers: Object.values(TIERS).map(({ id, label, plan, browserBootable }) => ({ id, label, plan, browserBootable })),
    });
  }
  const sample = url.pathname.match(/^\/api\/sample\/([a-z0-9]+)\.img$/);
  if (sample) return handleSample(res, sample[1]);
  if (STATIC[url.pathname]) return serveFile(res, STATIC[url.pathname]);

  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJSON(res, 403, { error: "Forbidden" });
  serveFile(res, file);
});

if (require.main === module) {
  for (const f of Object.values(STATIC)) {
    if (!fs.existsSync(f)) console.warn(`warning: missing ${path.relative(__dirname, f)} (run "npm install")`);
  }
  server.listen(PORT, () => {
    console.log(`KernelCraft running at http://localhost:${PORT}`);
    console.log(`LLM provider: ${provider.describe()}`);
  });
}

module.exports = { server };
