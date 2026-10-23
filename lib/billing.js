// Razorpay payments. Flow:
//   1. POST /api/billing/order    -> we create a Razorpay Order for the plan
//   2. Razorpay Checkout runs in the browser and returns payment_id + signature
//   3. POST /api/billing/verify   -> we check HMAC(order_id|payment_id) with the
//                                    key secret, then activate the plan
//   4. POST /api/billing/webhook  -> Razorpay's server-to-server confirmation
//                                    (order.paid / payment.captured), verified
//                                    with the webhook secret; activates the plan
//                                    even if the browser never came back.
// Amounts are set on the server from lib/plans.js, never taken from the client.
const crypto = require("crypto");
const store = require("./store");
const { PLANS } = require("./plans");

const KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";
const DEV_BILLING = process.env.KC_DEV_BILLING === "1";
const PLAN_DAYS = 30;

function configured() { return Boolean(KEY_ID && KEY_SECRET); }

function status() {
  return { razorpay: configured(), keyId: configured() ? KEY_ID : null, devBilling: DEV_BILLING && !configured() };
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

function paidPlan(planId) {
  const plan = PLANS[planId];
  if (!plan || !plan.pricePaise) throw new Error("Choose a paid plan");
  return plan;
}

async function createOrder(user, planId) {
  const plan = paidPlan(planId);
  if (!configured()) throw new Error("Payments are not configured on this server (set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64"),
    },
    body: JSON.stringify({
      amount: plan.pricePaise,
      currency: "INR",
      receipt: `kc_${Date.now()}`,
      notes: { userId: user.id, plan: plan.id },
    }),
  });
  const order = await res.json();
  if (!res.ok) throw new Error(order?.error?.description || `Razorpay error ${res.status}`);
  store.savePayment(order.id, { orderId: order.id, userId: user.id, plan: plan.id, amount: plan.pricePaise, status: "created", createdAt: Date.now() });
  return {
    keyId: KEY_ID,
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    planName: plan.name,
    prefill: { name: user.name, email: user.email },
  };
}

function activate(orderId, paymentId, via) {
  const payment = store.getPayment(orderId);
  if (!payment) throw new Error("Unknown order");
  if (payment.status === "paid") return store.getUser(payment.userId); // idempotent
  const user = store.getUser(payment.userId);
  // Same plan: extend from the current expiry. New plan: 30 days from now.
  const start = user.plan === payment.plan && user.planExpires > Date.now() ? user.planExpires : Date.now();
  store.savePayment(orderId, { status: "paid", paymentId, paidAt: Date.now(), via });
  return store.updateUser(user.id, { plan: payment.plan, planExpires: start + PLAN_DAYS * 24 * 3600 * 1000 });
}

function verifyCheckout(user, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }) {
  if (!configured()) throw new Error("Payments are not configured");
  const payment = store.getPayment(orderId);
  if (!payment || payment.userId !== user.id) throw new Error("Unknown order");
  if (!safeEqualHex(hmac(KEY_SECRET, `${orderId}|${paymentId}`), signature)) throw new Error("Payment signature mismatch");
  return activate(orderId, paymentId, "checkout");
}

// rawBody must be the exact bytes Razorpay sent.
function handleWebhook(rawBody, signature) {
  if (!WEBHOOK_SECRET) throw new Error("Webhook secret not configured");
  if (!safeEqualHex(hmac(WEBHOOK_SECRET, rawBody), signature)) throw new Error("Webhook signature mismatch");
  const event = JSON.parse(rawBody);
  if (event.event !== "order.paid" && event.event !== "payment.captured") return { ignored: event.event };
  const payment = event.payload?.payment?.entity;
  const orderId = payment?.order_id || event.payload?.order?.entity?.id;
  const expected = store.getPayment(orderId);
  if (!expected) return { ignored: "unknown order" };
  if (payment && Number(payment.amount) !== expected.amount) throw new Error("Amount mismatch");
  activate(orderId, payment?.id, "webhook");
  return { activated: orderId };
}

// Local development only: activates a plan without payment when
// KC_DEV_BILLING=1 and Razorpay is not configured.
function devActivate(user, planId) {
  if (!DEV_BILLING || configured()) throw new Error("Dev billing is disabled");
  paidPlan(planId);
  const orderId = `dev_${Date.now()}`;
  store.savePayment(orderId, { orderId, userId: user.id, plan: planId, amount: 0, status: "created", createdAt: Date.now() });
  return activate(orderId, "dev", "dev");
}

module.exports = { status, createOrder, verifyCheckout, handleWebhook, devActivate };
