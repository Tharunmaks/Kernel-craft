// App catalog: ready-made apps for SDK desktops (32-bit and 64-bit). Each
// app is one self-registering C file (KC_APP), so adding it is just adding
// the file; no AI call is needed.
const fs = require("fs");
const path = require("path");

const APP_DIR = path.join(__dirname, "..", "templates", "apps");
const SDK_TARGETS = ["prot32", "long64"];

const CATALOG = [
  { id: "browser", name: "Web", emoji: "🌐", category: "Internet", description: "Web browser with the Seek search engine, address bar, back/forward and links. Browses the OS's offline web and files (no network driver yet)." },
  { id: "paint", name: "Paint", emoji: "🎨", category: "Creative", description: "Brush, eraser, line, rectangle, circle and fill tools, 20 colours, undo, and save/open drawings." },
  { id: "snake", name: "Snake", emoji: "🐍", category: "Games", description: "Classic Snake with speed-up, sound effects and a saved high score." },
  { id: "mines", name: "Mines", emoji: "💣", category: "Games", description: "Minesweeper with Easy, Medium and Hard boards, flags and a timer." },
  { id: "clock", name: "Clock", emoji: "🕒", category: "Utilities", description: "Analog and digital clock, today's date, and a stopwatch with laps." },
  { id: "calendar", name: "Calendar", emoji: "📅", category: "Utilities", description: "Month view with today highlighted and notes for any day." },
  { id: "piano", name: "Piano", emoji: "🎹", category: "Creative", description: "Two-octave piano on the PC speaker, playable with mouse or keyboard, with a demo tune." },
];

const fileName = (id) => `app_${id}.c`;

function list() {
  return CATALOG.map((a) => ({ ...a, file: fileName(a.id), targets: SDK_TARGETS }));
}

// { "app_browser.c": "<source>", ... } for the given ids; unknown ids throw.
function filesFor(ids, tier) {
  const out = {};
  for (const id of ids || []) {
    const app = CATALOG.find((a) => a.id === id);
    if (!app) throw new Error(`Unknown app "${id}"`);
    if (!SDK_TARGETS.includes(tier.id)) throw new Error(`${app.name} needs a 32-bit or 64-bit target`);
    out[fileName(id)] = fs.readFileSync(path.join(APP_DIR, `${id}.c`), "utf8");
  }
  return out;
}

module.exports = { list, filesFor, SDK_TARGETS };
