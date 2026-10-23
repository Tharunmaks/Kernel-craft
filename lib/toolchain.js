// Step B and C of the pipeline: compile sources into a 1.44MB floppy image,
// then boot it headlessly in QEMU and capture a framebuffer screenshot.
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { parsePPM, encodePNG, imageStats } = require("./png");

const FLOPPY_BYTES = 1474560;
const SECTOR = 512;
const STEP_TIMEOUT_MS = 30_000;

const FILE_NAME = /^[A-Za-z0-9_-]{1,40}\.(asm|inc|c|h)$/;

class BuildError extends Error {
  constructor(message, log) {
    super(message);
    this.log = log;
  }
}

function run(cmd, args, { cwd, timeout = STEP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { PATH: process.env.PATH } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `${cmd}: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim() });
    });
  });
}

// Generated code is untrusted (the prompt is user input). Keep it inside the
// work directory: only flat file names, and no way to pull host files into
// the image through includes or incbin.
function validateSources(files) {
  const problems = [];
  for (const [name, src] of Object.entries(files)) {
    if (!FILE_NAME.test(name)) problems.push(`${name}: file names must be flat, like kernel.c or boot.asm`);
    if (/incbin/i.test(src)) problems.push(`${name}: incbin is not allowed`);
    if (/\.(c|h)$/.test(name) && /\.include\b/.test(src)) problems.push(`${name}: inline-asm .include is not allowed`);
    for (const m of src.matchAll(/^\s*[%#]\s*include\s*[<"]([^>"]+)[>"]/gim)) {
      if (!FILE_NAME.test(m[1])) problems.push(`${name}: include of "${m[1]}" is not allowed; only sibling files can be included`);
    }
    if (src.length > 400_000) problems.push(`${name}: file too large`);
  }
  return problems;
}

async function makeWorkDir(prefix = "kc-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function step(log, label, cmd, args, cwd) {
  const res = await run(cmd, args, { cwd });
  log.push(`$ ${cmd} ${args.join(" ")}${res.out ? "\n" + res.out : ""}`);
  if (res.code !== 0) throw new BuildError(`${label} failed`, log.join("\n"));
  return res;
}

async function buildImage(files, tier, workDir) {
  const log = [];
  const problems = validateSources(files);
  if (!files["boot.asm"]) problems.push("boot.asm is missing");
  if (problems.length) throw new BuildError("Source validation failed", problems.join("\n"));

  for (const [name, src] of Object.entries(files)) await fs.writeFile(path.join(workDir, name), src);

  if (tier.mode === "flat") {
    if (!files["kernel.asm"]) throw new BuildError("kernel.asm is missing", "kernel.asm is missing");
    await step(log, "Assembling kernel", "nasm", ["-f", "bin", "-o", "kernel.bin", "kernel.asm"], workDir);
  } else {
    if (!files["entry.asm"]) throw new BuildError("entry.asm is missing", "entry.asm is missing");
    const objects = [];
    const asm = Object.keys(files).filter((f) => f.endsWith(".asm") && f !== "boot.asm");
    // entry.o must come first so _start lands at the load address.
    asm.sort((a, b) => (a === "entry.asm" ? -1 : b === "entry.asm" ? 1 : a.localeCompare(b)));
    for (const f of asm) {
      const obj = f.replace(/\.asm$/, ".asm.o");
      await step(log, `Assembling ${f}`, "nasm", ["-f", tier.nasmFormat, "-o", obj, f], workDir);
      objects.push(obj);
    }
    for (const f of Object.keys(files).filter((f) => f.endsWith(".c")).sort()) {
      const obj = f.replace(/\.c$/, ".c.o");
      await step(log, `Compiling ${f}`, "gcc", [...tier.cflags, "-I.", "-c", f, "-o", obj], workDir);
      objects.push(obj);
    }
    // The linker script is engine-owned; a generated link.ld is ignored.
    await fs.copyFile(path.join(tier.templateDir, "link.ld"), path.join(workDir, "kc-link.ld"));
    await step(log, "Linking kernel", "ld", ["-m", tier.ldEmulation, "-T", "kc-link.ld", "--oformat", "binary", "-o", "kernel.bin", ...objects], workDir);
  }

  const kernel = await fs.readFile(path.join(workDir, "kernel.bin"));
  if (kernel.length === 0) throw new BuildError("Kernel is empty", log.join("\n"));
  if (kernel.length > tier.maxKernelBytes) {
    throw new BuildError("Kernel too large", `kernel.bin is ${kernel.length} bytes; limit for this tier is ${tier.maxKernelBytes}`);
  }
  const sectors = Math.ceil(kernel.length / SECTOR);
  await step(log, "Assembling boot sector", "nasm", ["-f", "bin", `-DKERNEL_SECTORS=${sectors}`, "-o", "boot.bin", "boot.asm"], workDir);

  const boot = await fs.readFile(path.join(workDir, "boot.bin"));
  if (boot.length !== SECTOR) throw new BuildError("Boot sector is not 512 bytes", `boot.bin is ${boot.length} bytes; it must be exactly 512 (pad with times 510-($-$$) db 0 / dw 0xAA55)`);
  if (boot[510] !== 0x55 || boot[511] !== 0xaa) throw new BuildError("Boot signature missing", "boot.bin must end with the 0xAA55 signature");

  const image = Buffer.alloc(FLOPPY_BYTES);
  boot.copy(image, 0);
  kernel.copy(image, SECTOR);
  await fs.writeFile(path.join(workDir, "floppy.img"), image);
  log.push(`floppy.img: boot sector + ${kernel.length} byte kernel (${sectors} sectors)`);
  return { image, kernelBytes: kernel.length, sectors, log: log.join("\n") };
}

// Boots floppy.img in QEMU with no display, waits bootWaitMs, then asks the
// QEMU monitor for a screendump. -no-reboot makes a triple fault end the VM,
// which we report as a crash.
function bootAndCapture(tier, workDir, { bootWaitMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const ppm = path.join(workDir, "screen.ppm");
    const serial = path.join(workDir, "serial.log");
    const args = [
      "-fda", path.join(workDir, "floppy.img"),
      "-boot", "a",
      "-m", "32",
      "-display", "none",
      "-monitor", "stdio",
      "-serial", `file:${serial}`,
      "-no-reboot",
    ];
    const qemu = spawn(tier.qemu, args, { env: { PATH: process.env.PATH } });
    let exited = false;
    let qemuOut = "";
    qemu.stdout.on("data", (d) => (qemuOut += d));
    qemu.stderr.on("data", (d) => (qemuOut += d));
    qemu.on("error", (err) => {
      exited = true;
      qemuOut += err.message;
    });
    qemu.on("close", () => (exited = true));

    const killTimer = setTimeout(() => qemu.kill("SIGKILL"), bootWaitMs + 10_000);

    const finish = async (crashed) => {
      clearTimeout(killTimer);
      let serialLog = "";
      try { serialLog = (await fs.readFile(serial, "utf8")).slice(-4000); } catch {}
      let png = null, stats = null;
      try {
        const frame = parsePPM(await fs.readFile(ppm));
        png = encodePNG(frame);
        stats = imageStats(frame);
      } catch {}
      if (!exited) qemu.kill("SIGKILL");
      resolve({ png, stats, serialLog, crashed, qemuOutput: qemuOut.replace(/\(qemu\)\s*/g, "").trim().slice(-2000) });
    };

    setTimeout(async () => {
      if (exited) return finish(true);
      qemu.stdin.write(`screendump ${ppm}\n`);
      // screendump is synchronous in the monitor; poll briefly for the file.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          const st = await fs.stat(ppm);
          if (st.size > 0) break;
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 100));
      qemu.stdin.write("quit\n");
      finish(false);
    }, bootWaitMs);
  });
}

async function readTemplate(tier) {
  const files = {};
  for (const name of await fs.readdir(tier.templateDir)) {
    if (name === "link.ld") continue;
    files[name] = await fs.readFile(path.join(tier.templateDir, name), "utf8");
  }
  return files;
}

module.exports = { buildImage, bootAndCapture, makeWorkDir, readTemplate, validateSources, BuildError };
