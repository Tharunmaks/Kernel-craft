// KernelCraft server: accounts, plans + Razorpay billing, projects, and the
// build & verification engine.
//
// Build API (NDJSON stream of {type:"log"|"pass"|"result"|"error"} events,
// or one JSON object with "Accept: application/json"):
//   POST /api/build-os  { prompt, target }                   new AI-built OS
//   POST /api/build-os  { projectId, change }                AI edit of a saved OS
//   POST /api/rebuild   { target, files, projectId? }        build edited sources, no AI
//
// Static: public/ (web app), /vendor/* (v86 emulator + BIOS images).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { TARGETS, getTier } = require("./lib/tiers");
const { createProvider } = require("./lib/providers");
const { buildOS } = require("./lib/pipeline");
const { readTemplate } = require("./lib/toolchain");
const { planFor, planForTarget, publicPlans } = require("./lib/plans");
const store = require("./lib/store");
const auth = require("./lib/auth");
const billing = require("./lib/billing");
const hardware = require("./lib/hardware");
const apps = require("./lib/apps");
const { SAMPLES, buildSample } = require("./lib/samples");

const PORT = Number(process.env.PORT) || 8086;
const MAX_CONCURRENT_BUILDS = Number(process.env.KC_MAX_BUILDS) || 2;

store.load();
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
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".gz": "application/gzip",
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

// ---------------------------------------------------------------- helpers ---
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJSON(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "Request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJSON(req, limit = 64 * 1024) {
  if (!(req.headers["content-type"] || "").includes("application/json")) throw new HttpError(415, "Send JSON");
  try {
    return JSON.parse((await readRaw(req, limit)).toString("utf8") || "{}");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "Body must be valid JSON");
  }
}

function serveFile(res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJSON(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Content-Length": st.size, ...extraHeaders });
    fs.createReadStream(file).pipe(res);
  });
}

function requireUser(req) {
  const user = auth.currentUser(req);
  if (!user) throw new HttpError(401, "Sign in to continue");
  return user;
}

function ownProject(user, id) {
  const project = store.getProject(id);
  if (!project || project.userId !== user.id) throw new HttpError(404, "Project not found");
  return project;
}

function account(user) {
  const plan = planFor(user);
  const usage = store.usageToday(user.id);
  return {
    user: auth.publicUser(user),
    plan: { id: plan.id, name: plan.name, targets: plan.targets, maxPasses: plan.maxPasses, bigFiles: plan.bigFiles },
    usage: { aiToday: usage.ai || 0, aiLimit: plan.aiBuildsPerDay, manualToday: usage.manual || 0, manualLimit: plan.manualBuildsPerDay },
  };
}

function checkTarget(plan, tier) {
  if (plan.targets.includes(tier.id)) return;
  const needed = planForTarget(tier.id);
  throw new HttpError(403, `${tier.label} needs the ${needed.name} plan`, { upgrade: needed.id });
}

function serializePass(p, includeShot) {
  return {
    pass: p.pass,
    stage: p.stage,
    verdict: p.verdict,
    stats: p.stats,
    ...(includeShot && p.png ? { screenshot: `data:image/png;base64,${p.png.toString("base64")}` } : {}),
  };
}

// Short display name for a new project: the architect's plan name, a
// "called X" / "named X" in the prompt, or the start of the prompt.
function projectName(prompt, plan) {
  if (plan && typeof plan.name === "string" && plan.name.trim()) return plan.name.trim().slice(0, 40);
  const m = /\b(?:called|named)\s+["']?([A-Za-z0-9][\w-]{1,30})/i.exec(prompt);
  if (m) return m[1];
  return prompt.length > 48 ? prompt.slice(0, 47).trimEnd() + "…" : prompt;
}

// Runs a pipeline job, streaming events, then saves the project.
async function runBuildJob(req, res, user, { tier, job, saveAs }) {
  const streaming = !(req.headers.accept || "").includes("application/json");
  if (streaming) res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  const emit = (event) => streaming && !res.writableEnded && res.write(JSON.stringify(event) + "\n");
  if (activeBuilds >= MAX_CONCURRENT_BUILDS) emit({ type: "log", agent: "system", message: "Waiting for a free build slot..." });

  try {
    const result = await withBuildSlot(() => job(emit));
    const final = result.final;
    let project = null;
    if (final) {
      project = await store.saveProjectBuild({
        ...saveAs,
        ...(saveAs.prompt && !saveAs.projectId && saveAs.name === undefined ? { name: projectName(saveAs.prompt, result.plan) } : {}),
        userId: user.id,
        target: tier.id,
        files: final.files,
        artifacts: final.artifacts,
        passes: result.passes,
        verified: result.verified,
        hardware: result.hardware,
      });
    }
    const payload = {
      type: "result",
      verified: result.verified,
      target: tier.id,
      browserBootable: tier.browserBootable,
      projectId: project?.id ?? null,
      finalPass: final?.pass ?? null,
      artifacts: final?.artifacts ? Object.keys(final.artifacts) : [],
      files: final?.files ?? result.lastFiles ?? null,
      serialLog: final?.serialLog ?? "",
      hardware: result.hardware,
      passes: result.passes.map((p) => serializePass(p, !streaming)),
      account: account(store.getUser(user.id)),
    };
    if (streaming) res.end(JSON.stringify(payload) + "\n");
    else sendJSON(res, 200, payload);
  } catch (err) {
    console.error("build failed:", err);
    if (streaming) res.end(JSON.stringify({ type: "error", message: err.message }) + "\n");
    else sendJSON(res, 500, { error: err.message });
  }
}

// ----------------------------------------------------------------- routes ---
async function buildOSRoute(req, res) {
  const user = requireUser(req);
  const body = await readJSON(req);
  const plan = planFor(user);
  let tier, prompt, baseFiles = null, changeRequest = null, saveAs;

  if (body.projectId) {
    const project = ownProject(user, body.projectId);
    changeRequest = typeof body.change === "string" ? body.change.trim() : "";
    if (!changeRequest || changeRequest.length > 4000) throw new HttpError(400, "Describe the change (1-4000 characters)");
    tier = getTier(project.target);
    prompt = project.prompt;
    baseFiles = await store.readProjectFiles(project.id);
    if (!baseFiles) throw new HttpError(409, "This project has no saved sources yet");
    saveAs = { projectId: project.id, request: changeRequest };
  } else {
    prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt || prompt.length > 4000) throw new HttpError(400, "Describe your OS (1-4000 characters)");
    try { tier = getTier(body.target || body.tier || "real16"); } catch (err) { throw new HttpError(400, err.message); }
    saveAs = { prompt };
  }
  checkTarget(plan, tier);
  let extraFiles = null;
  try { if (Array.isArray(body.apps) && body.apps.length) extraFiles = apps.filesFor(body.apps.slice(0, 20), tier); } catch (err) { throw new HttpError(400, err.message); }
  const hw = body.hardware || (body.projectId ? ownProject(user, body.projectId).hardware : null);
  const usage = store.usageToday(user.id);
  if ((usage.ai || 0) >= plan.aiBuildsPerDay) throw new HttpError(429, `You have used all ${plan.aiBuildsPerDay} AI builds for today on the ${plan.name} plan`, { upgrade: plan.id === "max" ? null : "max" });
  store.addUsage(user.id, "ai");

  return runBuildJob(req, res, user, {
    tier,
    saveAs,
    job: (emit) => buildOS({ prompt, tier, provider, maxPasses: plan.maxPasses, bigFiles: plan.bigFiles, baseFiles, changeRequest, extraFiles, hardware: hw, emit }),
  });
}

async function rebuildRoute(req, res) {
  const user = requireUser(req);
  const body = await readJSON(req, 4 * 1024 * 1024);
  const plan = planFor(user);
  let tier;
  try { tier = getTier(body.target); } catch (err) { throw new HttpError(400, err.message); }
  checkTarget(plan, tier);
  if (!body.files || typeof body.files !== "object") throw new HttpError(400, "files is required");
  if (Object.keys(body.files).length > 200) throw new HttpError(400, "Too many files");
  const usage = store.usageToday(user.id);
  if ((usage.manual || 0) >= plan.manualBuildsPerDay) throw new HttpError(429, "Daily rebuild limit reached");
  store.addUsage(user.id, "manual");
  let saveAs = { name: "Edited OS", prompt: "Manual build", request: "Manual edit" };
  let hw = body.hardware;
  if (body.projectId) {
    const project = ownProject(user, body.projectId);
    hw = hw || project.hardware;
    if (project.target !== tier.id) throw new HttpError(400, "Target does not match the project");
    saveAs = { projectId: project.id, request: "Manual edit" };
  }
  return runBuildJob(req, res, user, {
    tier,
    saveAs,
    job: (emit) => buildOS({ prompt: saveAs.prompt || "Manual build", tier, provider, maxPasses: 1, manualFiles: body.files, hardware: hw, emit }),
  });
}

const sampleCache = new Map();
async function sampleRoute(res, name) {
  if (!SAMPLES.includes(name)) throw new HttpError(404, "Unknown sample");
  if (!sampleCache.has(name)) sampleCache.set(name, await withBuildSlot(() => buildSample(name)));
  const image = sampleCache.get(name);
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="kernelcraft-${name}-sample.img"`, "Content-Length": image.length });
  res.end(image);
}

async function route(req, res, url) {
  const p = url.pathname;
  const m = (re) => p.match(re);
  const method = req.method;

  // --- auth
  if (method === "POST" && p === "/api/auth/signup") {
    let user;
    try { user = auth.signup(await readJSON(req)); } catch (err) { throw new HttpError(400, err.message); }
    return sendJSON(res, 200, account(user), { "Set-Cookie": auth.sessionCookie(auth.startSession(user), req) });
  }
  if (method === "POST" && p === "/api/auth/login") {
    let user;
    try { user = auth.login(await readJSON(req)); } catch (err) { throw new HttpError(401, err.message); }
    return sendJSON(res, 200, account(user), { "Set-Cookie": auth.sessionCookie(auth.startSession(user), req) });
  }
  if (method === "POST" && p === "/api/auth/logout") {
    auth.endSession(req);
    return sendJSON(res, 200, { ok: true }, { "Set-Cookie": auth.sessionCookie(null, req) });
  }
  if (method === "GET" && p === "/api/me") {
    const user = auth.currentUser(req);
    return sendJSON(res, 200, user ? account(user) : { user: null });
  }

  // --- catalogue
  if (method === "GET" && p === "/api/config") {
    return sendJSON(res, 200, {
      provider: provider.describe(),
      billing: billing.status(),
      plans: publicPlans(),
      targets: Object.values(TARGETS).map(({ id, label, browserBootable, builder }) => ({ id, label, browserBootable, builder, plan: planForTarget(id).id })),
      hardware: hardware.options(),
      apps: apps.list(),
      showcaseHardware: apps.SHOWCASE_HARDWARE,
    });
  }
  if (method === "GET" && m(/^\/api\/apps\/([a-z0-9]+)$/)) {
    const id = m(/^\/api\/apps\/([a-z0-9]+)$/)[1];
    try { return sendJSON(res, 200, { id, files: apps.filesFor([id], getTier("prot32")) }); } catch (err) { throw new HttpError(404, err.message); }
  }
  if (method === "GET" && p === "/api/sdk") {
    return sendJSON(res, 200, { files: await readTemplate(getTier("prot32")), forge: await readTemplate(getTier("linux64")) });
  }
  if (method === "GET" && m(/^\/api\/sample\/([a-z0-9]+)\.img$/)) return sampleRoute(res, m(/^\/api\/sample\/([a-z0-9]+)\.img$/)[1]);

  // --- billing
  if (method === "POST" && p === "/api/billing/order") {
    const user = requireUser(req);
    const { plan } = await readJSON(req);
    try { return sendJSON(res, 200, await billing.createOrder(user, plan)); } catch (err) { throw new HttpError(400, err.message); }
  }
  if (method === "POST" && p === "/api/billing/verify") {
    const user = requireUser(req);
    try { billing.verifyCheckout(user, await readJSON(req)); } catch (err) { throw new HttpError(400, err.message); }
    return sendJSON(res, 200, account(store.getUser(user.id)));
  }
  if (method === "POST" && p === "/api/billing/webhook") {
    const raw = (await readRaw(req, 256 * 1024)).toString("utf8");
    try { return sendJSON(res, 200, billing.handleWebhook(raw, req.headers["x-razorpay-signature"])); } catch (err) { throw new HttpError(400, err.message); }
  }
  if (method === "POST" && p === "/api/billing/dev-activate") {
    const user = requireUser(req);
    const { plan } = await readJSON(req);
    try { billing.devActivate(user, plan); } catch (err) { throw new HttpError(400, err.message); }
    return sendJSON(res, 200, account(store.getUser(user.id)));
  }

  // --- builds
  if (method === "POST" && p === "/api/build-os") return buildOSRoute(req, res);
  if (method === "POST" && p === "/api/rebuild") return rebuildRoute(req, res);

  // --- projects
  if (method === "GET" && p === "/api/projects") {
    const user = requireUser(req);
    return sendJSON(res, 200, { projects: store.listProjects(user.id) });
  }
  let pm;
  if ((pm = m(/^\/api\/projects\/([A-Za-z0-9_-]+)$/))) {
    const user = requireUser(req);
    const project = ownProject(user, pm[1]);
    if (method === "DELETE") { await store.deleteProject(project.id); return sendJSON(res, 200, { ok: true }); }
    if (method === "GET") return sendJSON(res, 200, { project, files: await store.readProjectFiles(project.id) });
  }
  if (method === "GET" && (pm = m(/^\/api\/projects\/([A-Za-z0-9_-]+)\/(artifacts|shots)\/([A-Za-z0-9._-]+)$/))) {
    const user = requireUser(req);
    const project = ownProject(user, pm[1]);
    const file = store.projectFilePath(project.id, pm[2], pm[3]);
    if (!file) throw new HttpError(404, "Not found");
    const download = pm[2] === "artifacts" ? { "Content-Disposition": `attachment; filename="${pm[3]}"` } : {};
    return serveFile(res, file, download);
  }

  // --- static
  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
  if (STATIC[p]) return serveFile(res, STATIC[p]);
  const rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, "Forbidden");
  return serveFile(res, file);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    await route(req, res, url);
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) return sendJSON(res, err.status, { error: err.message, ...(err.extra || {}) });
    console.error(err);
    sendJSON(res, 500, { error: "Internal error" });
  }
});

if (require.main === module) {
  for (const f of Object.values(STATIC)) {
    if (!fs.existsSync(f)) console.warn(`warning: missing ${path.relative(__dirname, f)} (run "npm install")`);
  }
  if (!fs.existsSync(path.join(TARGETS.linux64.linuxBase, "vmlinuz"))) console.warn('warning: Linux Forge base missing (run "npm run setup:linux")');
  server.listen(PORT, () => {
    console.log(`KernelCraft running at http://localhost:${PORT}`);
    console.log(`LLM provider: ${provider.describe()}`);
    const b = billing.status();
    console.log(`Payments: ${b.razorpay ? "Razorpay" : b.devBilling ? "dev mode (plans activate without payment)" : "not configured"}`);
  });
  const shutdown = () => { store.saveNow(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { server, projectName };
