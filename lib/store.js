// Small persistent store: one JSON document for users, sessions, payments,
// usage and project metadata, plus a directory per project for its files,
// artifacts and screenshots. Good for a prototype on one server; move to a
// real database before running several instances.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.KC_DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");

let db = { users: {}, sessions: {}, payments: {}, usage: {}, projects: {} };
let saveTimer = null;

function load() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function save() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 200);
}

const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;

// ------------------------------------------------------------------ users ---
function findUserByEmail(email) {
  return Object.values(db.users).find((u) => u.email === email) || null;
}
function getUser(id) { return db.users[id] || null; }
function createUser(fields) {
  const user = { id: newId("usr"), createdAt: Date.now(), plan: "free", planExpires: 0, ...fields };
  db.users[user.id] = user;
  save();
  return user;
}
function updateUser(id, patch) {
  Object.assign(db.users[id], patch);
  save();
  return db.users[id];
}

// --------------------------------------------------------------- sessions ---
function createSession(userId, ttlMs) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.sessions[token] = { userId, expires: Date.now() + ttlMs };
  save();
  return token;
}
function getSession(token) {
  const s = token && db.sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) { delete db.sessions[token]; save(); return null; }
  return s;
}
function deleteSession(token) { delete db.sessions[token]; save(); }

// --------------------------------------------------------------- payments ---
function savePayment(orderId, record) { db.payments[orderId] = { ...(db.payments[orderId] || {}), ...record }; save(); return db.payments[orderId]; }
function getPayment(orderId) { return db.payments[orderId] || null; }
function paymentsForUser(userId) { return Object.values(db.payments).filter((p) => p.userId === userId); }

// ------------------------------------------------------------------ usage ---
const today = () => new Date().toISOString().slice(0, 10);
function usageToday(userId) {
  const u = db.usage[userId];
  return u && u.date === today() ? u : { date: today(), ai: 0, manual: 0 };
}
function addUsage(userId, kind) {
  const u = usageToday(userId);
  u[kind] = (u[kind] || 0) + 1;
  db.usage[userId] = u;
  save();
  return u;
}

// --------------------------------------------------------------- projects ---
const projectDir = (id) => path.join(PROJECTS_DIR, id.replace(/[^A-Za-z0-9_-]/g, ""));

function listProjects(userId) {
  return Object.values(db.projects).filter((p) => p.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt);
}
function getProject(id) { return db.projects[id] || null; }

async function saveProjectBuild({ projectId, userId, name, prompt, target, files, artifacts, passes, verified, request }) {
  let project = projectId && db.projects[projectId];
  if (!project) {
    project = { id: newId("prj"), userId, name, prompt, target, createdAt: Date.now(), history: [] };
    db.projects[project.id] = project;
  }
  const dir = projectDir(project.id);
  await fsp.mkdir(path.join(dir, "artifacts"), { recursive: true });
  await fsp.mkdir(path.join(dir, "shots"), { recursive: true });
  await fsp.writeFile(path.join(dir, "files.json"), JSON.stringify(files));
  // replace artifacts from the previous build
  for (const f of await fsp.readdir(path.join(dir, "artifacts"))) await fsp.rm(path.join(dir, "artifacts", f));
  for (const [name, buf] of Object.entries(artifacts || {})) await fsp.writeFile(path.join(dir, "artifacts", name), buf);
  const build = project.history.length + 1;
  const shots = [];
  for (const p of passes) {
    if (!p.png) continue;
    const file = `b${build}-p${p.pass}.png`;
    await fsp.writeFile(path.join(dir, "shots", file), p.png);
    shots.push(file);
  }
  project.history.push({ build, at: Date.now(), request: request || prompt, verified, passes: passes.length, shots });
  Object.assign(project, { target, updatedAt: Date.now(), artifacts: Object.keys(artifacts || {}), verified });
  if (name && !project.name) project.name = name;
  save();
  return project;
}

async function readProjectFiles(id) {
  try {
    return JSON.parse(await fsp.readFile(path.join(projectDir(id), "files.json"), "utf8"));
  } catch {
    return null;
  }
}

function projectFilePath(id, kind, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  return path.join(projectDir(id), kind, name);
}

async function deleteProject(id) {
  delete db.projects[id];
  save();
  await fsp.rm(projectDir(id), { recursive: true, force: true });
}

module.exports = {
  load, saveNow, newId,
  findUserByEmail, getUser, createUser, updateUser,
  createSession, getSession, deleteSession,
  savePayment, getPayment, paymentsForUser,
  usageToday, addUsage,
  listProjects, getProject, saveProjectBuild, readProjectFiles, projectFilePath, deleteProject,
};
