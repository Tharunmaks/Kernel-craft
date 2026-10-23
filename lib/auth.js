// Email + password accounts with HttpOnly session cookies.
const crypto = require("crypto");
const store = require("./store");

const COOKIE = "kc_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, req) {
  const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : "";
  const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0;
  return `${COOKIE}=${token || ""}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  const session = store.getSession(token);
  return session ? store.getUser(session.userId) : null;
}

function signup({ email, password, name }) {
  email = String(email || "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error("Enter a valid email address");
  if (typeof password !== "string" || password.length < 8) throw new Error("Password must be at least 8 characters");
  if (store.findUserByEmail(email)) throw new Error("An account with this email already exists");
  return store.createUser({ email, name: String(name || "").trim().slice(0, 60) || email.split("@")[0], password: hashPassword(password) });
}

function login({ email, password }) {
  const user = store.findUserByEmail(String(email || "").trim().toLowerCase());
  if (!user || typeof password !== "string" || !checkPassword(password, user.password)) throw new Error("Wrong email or password");
  return user;
}

function startSession(user) { return store.createSession(user.id, SESSION_TTL_MS); }
function endSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (token) store.deleteSession(token);
}

function publicUser(user) {
  if (!user) return null;
  const { password, ...rest } = user;
  return rest;
}

module.exports = { signup, login, startSession, endSession, currentUser, sessionCookie, publicUser };
