// Accounts, plan gating and Razorpay billing, exercised through the HTTP server.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.KC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kc-test-"));
process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_KEY_SECRET = "key_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "hook_secret";
process.env.KC_PROVIDER = "offline";

const { PLANS, planFor, planForTarget, publicPlans } = require("../lib/plans");
const { server, projectName } = require("../server");

// Fake Razorpay Orders API; everything else goes to the real fetch.
const realFetch = globalThis.fetch;
const razorpayOrders = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.razorpay.com/")) {
    const body = JSON.parse(init.body);
    razorpayOrders.push({ body, auth: init.headers.Authorization });
    return new Response(JSON.stringify({ id: `order_${razorpayOrders.length}`, amount: body.amount, currency: body.currency }), { status: 200 });
  }
  return realFetch(url, init);
};

const sign = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");

let base;
test.before(() => new Promise((r) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); require("../lib/store").saveNow(); fs.rmSync(process.env.KC_DATA_DIR, { recursive: true, force: true }); });

function client() {
  let cookie = "";
  return async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, body: await res.json() };
  };
}

test("plans", () => {
  assert.deepStrictEqual(Object.values(PLANS).map((p) => p.pricePaise / 100), [0, 700, 2000, 10000]);
  assert.strictEqual(planForTarget("real16").id, "plus");
  assert.strictEqual(planForTarget("prot32").id, "pro");
  assert.strictEqual(planForTarget("long64").id, "max");
  assert.strictEqual(planForTarget("linux64").id, "max");
  assert.strictEqual(planFor({ plan: "max", planExpires: Date.now() - 1 }).id, "free", "expired plans fall back to free");
  assert.ok(publicPlans().every((p) => !("pricePaise" in p)));
});

test("project names", () => {
  assert.strictEqual(projectName("x", { name: "Nova" }), "Nova");
  assert.strictEqual(projectName("A desktop OS called Orbit with a dock"), "Orbit");
  assert.strictEqual(projectName("short prompt"), "short prompt");
});

test("signup, sessions and plan gating", async () => {
  const api = client();
  assert.strictEqual((await api("POST", "/api/auth/signup", { email: "a@example.com", password: "short" })).status, 400);
  const signup = await api("POST", "/api/auth/signup", { email: "a@example.com", password: "password123", name: "A" });
  assert.strictEqual(signup.status, 200);
  assert.strictEqual((await api("GET", "/api/me")).body.plan.id, "free");
  assert.strictEqual((await api("POST", "/api/auth/signup", { email: "A@example.com", password: "password123" })).status, 400, "duplicate email");

  const denied = await api("POST", "/api/build-os", { prompt: "an OS", target: "real16" });
  assert.strictEqual(denied.status, 403);
  assert.strictEqual(denied.body.upgrade, "plus");

  await api("POST", "/api/auth/logout");
  assert.strictEqual((await api("GET", "/api/me")).body.user, null);
  assert.strictEqual((await api("POST", "/api/build-os", { prompt: "x" })).status, 401);
  assert.strictEqual((await api("POST", "/api/auth/login", { email: "a@example.com", password: "wrong-password" })).status, 401);
  assert.strictEqual((await api("POST", "/api/auth/login", { email: "a@example.com", password: "password123" })).status, 200);
});

test("Razorpay checkout: server-side amount, signature check, plan activation", async () => {
  const api = client();
  await api("POST", "/api/auth/signup", { email: "b@example.com", password: "password123" });
  assert.strictEqual((await api("POST", "/api/billing/order", { plan: "free" })).status, 400);
  const order = await api("POST", "/api/billing/order", { plan: "pro", amount: 1 });
  assert.strictEqual(order.status, 200);
  assert.strictEqual(order.body.amount, 200000, "amount comes from the server, not the client");
  assert.strictEqual(razorpayOrders.at(-1).auth, "Basic " + Buffer.from("rzp_test_key:key_secret").toString("base64"));

  const orderId = order.body.orderId;
  const forged = await api("POST", "/api/billing/verify", { razorpay_order_id: orderId, razorpay_payment_id: "pay_1", razorpay_signature: "00".repeat(32) });
  assert.strictEqual(forged.status, 400);
  assert.strictEqual((await api("GET", "/api/me")).body.plan.id, "free");

  const ok = await api("POST", "/api/billing/verify", { razorpay_order_id: orderId, razorpay_payment_id: "pay_1", razorpay_signature: sign("key_secret", `${orderId}|pay_1`) });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.plan.id, "pro");

  // Another user cannot claim this order.
  const other = client();
  await other("POST", "/api/auth/signup", { email: "c@example.com", password: "password123" });
  assert.strictEqual((await other("POST", "/api/billing/verify", { razorpay_order_id: orderId, razorpay_payment_id: "pay_1", razorpay_signature: sign("key_secret", `${orderId}|pay_1`) })).status, 400);
});

test("Razorpay webhook: signed, amount-checked, activates the plan", async () => {
  const api = client();
  await api("POST", "/api/auth/signup", { email: "d@example.com", password: "password123" });
  const { body: { orderId } } = await api("POST", "/api/billing/order", { plan: "max" });
  const event = (amount) => JSON.stringify({ event: "order.paid", payload: { payment: { entity: { id: "pay_9", order_id: orderId, amount } } } });

  const unsigned = await api("POST", "/api/billing/webhook", event(1000000), { "X-Razorpay-Signature": "bad" });
  assert.strictEqual(unsigned.status, 400);
  const cheap = event(100);
  assert.strictEqual((await api("POST", "/api/billing/webhook", cheap, { "X-Razorpay-Signature": sign("hook_secret", cheap) })).status, 400, "amount mismatch");
  assert.strictEqual((await api("GET", "/api/me")).body.plan.id, "free");

  const paid = event(1000000);
  const res = await api("POST", "/api/billing/webhook", paid, { "X-Razorpay-Signature": sign("hook_secret", paid) });
  assert.strictEqual(res.status, 200);
  const me = (await api("GET", "/api/me")).body;
  assert.strictEqual(me.plan.id, "max");
  // Replaying the same webhook does not extend the plan again.
  const expires = me.user.planExpires;
  await api("POST", "/api/billing/webhook", paid, { "X-Razorpay-Signature": sign("hook_secret", paid) });
  assert.strictEqual((await api("GET", "/api/me")).body.user.planExpires, expires);
});

test("config lists hardware options and the app catalog; apps can be fetched", async () => {
  const api = client();
  const config = (await api("GET", "/api/config")).body;
  assert.ok(config.hardware.resolutions.includes("1920x1080"));
  assert.ok(config.apps.some((a) => a.id === "browser"));
  const app = await api("GET", "/api/apps/browser");
  assert.match(app.body.files["app_browser.c"], /KC_APP\(browser/);
  assert.strictEqual((await api("GET", "/api/apps/nope")).status, 404);
});

test("dev billing is off when Razorpay is configured", async () => {
  const api = client();
  await api("POST", "/api/auth/signup", { email: "e@example.com", password: "password123" });
  assert.strictEqual((await api("POST", "/api/billing/dev-activate", { plan: "max" })).status, 400);
});
