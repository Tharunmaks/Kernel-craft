// Downloads the SeaBIOS / SeaVGABIOS images v86 needs into vendor/bios/.
// Runs on `npm install`; skips files that are already present.
const fs = require("fs");
const path = require("path");

const BASE = "https://raw.githubusercontent.com/copy/v86/master/bios/";
const DIR = path.join(__dirname, "..", "vendor", "bios");

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  for (const name of ["seabios.bin", "vgabios.bin"]) {
    const dest = path.join(DIR, name);
    if (fs.existsSync(dest)) continue;
    try {
      const res = await fetch(BASE + name);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      console.log(`fetched ${name}`);
    } catch (err) {
      console.warn(`could not fetch ${name} (${err.message}); download it from ${BASE}${name} into vendor/bios/`);
    }
  }
})();
