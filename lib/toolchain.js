// Steps B and C of the pipeline: compile sources into bootable artifacts
// (a 1.44MB floppy image, or a Linux kernel + initramfs), then boot them
// headlessly in QEMU and capture a framebuffer screenshot.
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { parsePPM, encodePNG, imageStats } = require("./png");
const { cpioNewc, tar } = require("./archive");
const hardware = require("./hardware");

const FLOPPY_BYTES = 1474560;
const SECTOR = 512;
const STEP_TIMEOUT_MS = 60_000;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const FLAT_NAME = /^[A-Za-z0-9_-]{1,40}\.(asm|inc|c|h)$/;
const LINUX_CMDLINE = hardware.linuxCmdline({ resolution: "1024x768" });

class BuildError extends Error {
  constructor(message, log) {
    super(message);
    this.log = log;
  }
}

function run(cmd, args, { cwd, timeout = STEP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { PATH: process.env.PATH, LANG: "C" } });
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

function validPath(name, tier) {
  if (tier.builder !== "linux") return FLAT_NAME.test(name);
  const parts = name.split("/");
  if (parts.length < 2 || parts.length > 8 || !parts.every((p) => SEGMENT.test(p) && p !== "..")) return false;
  if (parts[0] === "src") return parts.length === 2 && /\.(c|h)$/.test(parts[1]);
  return parts[0] === "rootfs";
}

// Generated code is untrusted (the prompt is user input). Keep it inside the
// work directory: only safe relative names, and no way to pull host files
// into an artifact through includes or incbin.
function validateSources(files, tier = { builder: "floppy" }) {
  const problems = [];
  for (const [name, src] of Object.entries(files)) {
    if (!validPath(name, tier)) {
      problems.push(tier.builder === "linux"
        ? `${name}: files must be rootfs/<path> or src/<name>.c|.h`
        : `${name}: file names must be flat, like kernel.c or boot.asm`);
      continue;
    }
    if (typeof src !== "string") { problems.push(`${name}: content must be text`); continue; }
    const code = /\.(asm|inc|c|h)$/.test(name);
    if (code && /incbin/i.test(src)) problems.push(`${name}: incbin is not allowed`);
    if (/\.(c|h)$/.test(name) && /\.include\b/.test(src)) problems.push(`${name}: inline-asm .include is not allowed`);
    if (code) {
      for (const m of src.matchAll(/^\s*[%#]\s*include\s*"([^"]+)"/gim)) {
        if (!/^[A-Za-z0-9_-]{1,40}\.(h|inc)$/.test(m[1])) problems.push(`${name}: include of "${m[1]}" is not allowed; only sibling headers can be included`);
      }
      for (const m of src.matchAll(/^\s*#\s*include\s*<([^>]+)>/gim)) {
        if (tier.builder !== "linux") problems.push(`${name}: system header <${m[1]}> is not available in a freestanding kernel; include "kc.h"`);
        else if (m[1].startsWith("/") || m[1].includes("..")) problems.push(`${name}: include <${m[1]}> is not allowed`);
      }
    }
    if (src.length > 600_000) problems.push(`${name}: file too large`);
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

async function writeSources(files, workDir) {
  for (const [name, src] of Object.entries(files)) {
    const dest = path.join(workDir, name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, src);
  }
}

// ------------------------------------------------------------ floppy builds ---
async function buildFloppy(files, tier, workDir, log, hw) {
  if (!files["boot.asm"]) throw new BuildError("boot.asm is missing", "boot.asm is missing");
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
    // Compile in parallel; collect every error before failing so one repair
    // round can fix them all.
    const cFiles = Object.keys(files).filter((f) => f.endsWith(".c")).sort();
    const results = await Promise.all(cFiles.map((f) => run("gcc", [...tier.cflags, "-I.", "-c", f, "-o", `${f}.o`], { cwd: workDir })));
    const failed = [];
    results.forEach((res, i) => {
      log.push(`$ gcc ${cFiles[i]}${res.out ? "\n" + res.out : ""}`);
      if (res.code !== 0) failed.push(cFiles[i]);
      objects.push(`${cFiles[i]}.o`);
    });
    if (failed.length) throw new BuildError(`Compiling ${failed.join(", ")} failed`, log.join("\n"));
    // The linker script is engine-owned; a generated link.ld is ignored.
    const archDir = tier.templateDirs[tier.templateDirs.length - 1];
    await fs.copyFile(path.join(archDir, "link.ld"), path.join(workDir, "kc-link.ld"));
    await step(log, "Linking kernel", "ld", ["-m", tier.ldEmulation, "-T", "kc-link.ld", "--oformat", "binary", "-o", "kernel.bin", ...objects], workDir);
  }

  const kernel = await fs.readFile(path.join(workDir, "kernel.bin"));
  if (kernel.length === 0) throw new BuildError("Kernel is empty", log.join("\n"));
  if (kernel.length > tier.maxKernelBytes) {
    throw new BuildError("Kernel too large", `kernel.bin is ${kernel.length} bytes; limit for this target is ${tier.maxKernelBytes}`);
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
  const runScript = `#!/bin/sh\n# Boot this KernelCraft OS with QEMU (${hardware.describe(hw)})\nexec ${tier.qemu} ${hardware.qemuArgs(hw, tier).join(" ")} -fda floppy.img -boot a\n`;
  return { artifacts: { "floppy.img": image, "run-qemu.sh": Buffer.from(runScript) }, summary: `floppy.img: ${(kernel.length / 1024).toFixed(1)} KB kernel in ${sectors} sectors` };
}

// ------------------------------------------------------------- Linux Forge ---
let busyboxApplets = null;

async function linuxBase(tier) {
  const kernelPath = path.join(tier.linuxBase, "vmlinuz");
  const busyboxPath = path.join(tier.linuxBase, "busybox");
  try {
    await fs.access(kernelPath);
    await fs.access(busyboxPath);
  } catch {
    throw new BuildError("Linux base not installed", `Missing ${kernelPath} or ${busyboxPath}. Run: npm run setup:linux`);
  }
  if (!busyboxApplets) {
    const res = await run(busyboxPath, ["--list"]);
    if (res.code !== 0) throw new BuildError("BusyBox does not run on this host", res.out);
    busyboxApplets = res.out.split(/\s+/).filter((a) => a && a !== "busybox" && SEGMENT.test(a));
  }
  return { kernel: await fs.readFile(kernelPath), busybox: await fs.readFile(busyboxPath) };
}

async function buildLinux(files, tier, workDir, log, hw) {
  if (!files["rootfs/init"]) throw new BuildError("rootfs/init is missing", "rootfs/init (PID 1) is missing");
  const base = await linuxBase(tier);

  // compile src/*.c into static binaries
  const programs = Object.keys(files).filter((f) => /^src\/[^/]+\.c$/.test(f)).sort();
  await fs.mkdir(path.join(workDir, "out"), { recursive: true });
  const results = await Promise.all(programs.map((f) => {
    const name = path.basename(f, ".c");
    return run("gcc", ["-static", "-O2", "-Wall", "-Isrc", "-o", `out/${name}`, f], { cwd: workDir });
  }));
  const failed = [];
  results.forEach((res, i) => {
    log.push(`$ gcc -static ${programs[i]}${res.out ? "\n" + res.out : ""}`);
    if (res.code !== 0) failed.push(programs[i]);
  });
  if (failed.length) throw new BuildError(`Compiling ${failed.join(", ")} failed`, log.join("\n"));

  const entries = [];
  const dirs = new Set();
  const addDir = (p) => {
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (!dirs.has(d)) { dirs.add(d); entries.push({ path: d, type: "dir" }); }
    }
  };
  for (const d of ["bin", "sbin", "usr/bin", "usr/sbin", "etc", "proc", "sys", "dev", "tmp", "run", "root", "home", "var/log", "mnt"]) addDir(d);
  entries.push({ path: "bin/busybox", type: "file", mode: 0o755, data: base.busybox });
  for (const a of busyboxApplets) entries.push({ path: `bin/${a}`, type: "symlink", target: "/bin/busybox" });

  const generated = new Set();
  for (const [name, src] of Object.entries(files)) {
    if (!name.startsWith("rootfs/")) continue;
    const rel = name.slice("rootfs/".length);
    addDir(path.posix.dirname(rel));
    const exec = src.startsWith("#!") || rel === "init";
    entries.push({ path: rel, type: "file", mode: exec ? 0o755 : 0o644, data: Buffer.from(src) });
    generated.add(rel);
  }
  for (const f of programs) {
    const name = path.basename(f, ".c");
    entries.push({ path: `usr/bin/${name}`, type: "file", mode: 0o755, data: await fs.readFile(path.join(workDir, "out", name)) });
  }
  // later entries win when unpacked, so generated files override applet links
  const initrd = zlib.gzipSync(cpioNewc(entries), { level: 6 });
  await fs.writeFile(path.join(workDir, "vmlinuz"), base.kernel);
  await fs.writeFile(path.join(workDir, "initrd.img"), initrd);

  const runScript = `#!/bin/sh\n# Boot this Forge OS with QEMU (${hardware.describe(hw)})\nexec qemu-system-x86_64 ${hardware.qemuArgs(hw, tier).join(" ")} -kernel vmlinuz -initrd initrd.img -append "${hardware.linuxCmdline(hw)}"\n`;
  const exportTar = zlib.gzipSync(tar([
    { path: "forge", type: "dir" },
    { path: "forge/vmlinuz", type: "file", data: base.kernel },
    { path: "forge/initrd.img", type: "file", data: initrd },
    { path: "forge/run-qemu.sh", type: "file", mode: 0o755, data: Buffer.from(runScript) },
    { path: "forge/README.txt", type: "file", data: Buffer.from("Built with KernelCraft Linux Forge.\nRun ./run-qemu.sh (needs qemu-system-x86_64).\n") },
  ]));
  log.push(`initrd.img: ${programs.length} programs, ${generated.size} files, ${(initrd.length / 1024).toFixed(0)} KB`);
  return {
    artifacts: { "vmlinuz": base.kernel, "initrd.img": initrd, "forge.tar.gz": exportTar },
    summary: `Linux ${(base.kernel.length / 1048576).toFixed(1)} MB kernel + ${(initrd.length / 1024).toFixed(0)} KB initramfs (${programs.length} programs)`,
  };
}

async function buildArtifacts(files, tier, workDir, hw = hardware.normalize(null, tier).hw) {
  const log = [];
  const problems = validateSources(files, tier);
  if (problems.length) throw new BuildError("Source validation failed", problems.join("\n"));
  // SDK kernels read their resolution etc. from the engine-owned kc_config.c.
  if (tier.mode === "linked") files = { ...files, "kc_config.c": hardware.configSource(hw) };
  await writeSources(files, workDir);
  const built = tier.builder === "linux" ? await buildLinux(files, tier, workDir, log, hw) : await buildFloppy(files, tier, workDir, log, hw);
  return { ...built, log: log.join("\n") };
}

// Boots the artifacts in QEMU with no display, waits, then asks the QEMU
// monitor for a screendump. -no-reboot makes a triple fault end the VM,
// which we report as a crash.
function bootAndCapture(tier, workDir, { bootWaitMs = tier.bootWaitMs || 3000, hw = hardware.normalize(null, tier).hw } = {}) {
  return new Promise((resolve) => {
    const ppm = path.join(workDir, "screen.ppm");
    const serial = path.join(workDir, "serial.log");
    const machine = tier.builder === "linux"
      ? ["-kernel", path.join(workDir, "vmlinuz"), "-initrd", path.join(workDir, "initrd.img"), "-append", hardware.linuxCmdline(hw)]
      : ["-fda", path.join(workDir, "floppy.img"), "-boot", "a"];
    machine.push(...hardware.qemuArgs(hw, tier, { test: true }));
    const args = [...machine, "-display", "none", "-monitor", "stdio", "-serial", `file:${serial}`, "-no-reboot"];
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

    const killTimer = setTimeout(() => qemu.kill("SIGKILL"), bootWaitMs + 15_000);

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
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        try {
          const st = await fs.stat(ppm);
          if (st.size > 0) break;
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 150));
      qemu.stdin.write("quit\n");
      finish(false);
    }, bootWaitMs);
  });
}

async function readDirFiles(dir, prefix, out) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) await readDirFiles(path.join(dir, ent.name), rel, out);
    else if (ent.name !== "link.ld") out[rel] = await fs.readFile(path.join(dir, ent.name), "utf8");
  }
  return out;
}

// Merges the target's template directories; later ones override earlier ones.
async function readTemplate(tier) {
  const files = {};
  for (const dir of tier.templateDirs) await readDirFiles(dir, "", files);
  return files;
}

module.exports = { buildArtifacts, bootAndCapture, makeWorkDir, readTemplate, validateSources, BuildError, LINUX_CMDLINE };
