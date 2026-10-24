// Build targets: what an OS is built from, how, and where it runs.
// (Which plan may use which target lives in lib/plans.js.)
const path = require("path");

const TEMPLATE_ROOT = path.join(__dirname, "..", "templates");
const LINUX_BASE = process.env.KC_LINUX_BASE || path.join(__dirname, "..", "vendor", "linux-base");

const COMMON_CFLAGS = [
  "-ffreestanding",
  "-fno-pie",
  "-fno-pic",
  "-fno-stack-protector",
  "-fno-builtin",
  "-fno-tree-loop-distribute-patterns",
  "-fno-asynchronous-unwind-tables",
  "-mno-sse",
  "-mno-mmx",
  "-nostdlib",
  "-nostdinc",
  "-O2",
  "-Wall",
];

const SDK_BRIEF = [
  "The KernelCraft SDK (kc.h) is already provided and boots to an 800x600x32 desktop: IDT + PIC + 100Hz PIT timer, COM1 logging (kc_log), heap (kmalloc/kfree, 2MB..end of RAM), string + kc_snprintf, PS/2 keyboard + mouse events, 2D graphics with an 8x16 font, a RAM filesystem, a compositing window manager with taskbar/start menu/toasts, a shell with commands, and apps: terminal, files, notepad, calc, sysmon, settings.",
  "Extend the OS by adding new .c files that use KC_APP(...) for apps, KC_COMMAND(...) for shell commands and KC_BOOT_HOOK(...) for startup code (themes, wallpapers via theme.draw_wallpaper, opening windows, seeding files). These register through linker sections, so no other file has to change.",
  "You may also replace any SDK file (wm.c, kernel.c, app_*.c, ...) by outputting a file with the same name, but keep every function declared in kc.h working.",
  "Freestanding C only: no libc and no system headers. Include \"kc.h\" (and your own headers). Large buffers must come from kmalloc: the kernel image plus .bss has to end below 0x70000 (about 380KB).",
  "There is no floating-point unit setup: use integer or fixed-point math only.",
  "The machine is configured by the user (kc_hw: width, height, ram_mb, vram_mb, cpus); never hardcode 800x600, use SCREEN_W/SCREEN_H. cpu_brand(), cpu_count(), gfx_vram_kb() and gfx_adapter_name() describe the hardware. The SDK runs on the boot CPU only.",
  "Animations and games: set w->tick_ms (e.g. 50) to get EV_TICK that often. speaker_tone(hz)/speaker_off() drive the PC speaker. Icons available: icon_terminal, icon_folder, icon_document, icon_chart, icon_gear, icon_info, icon_calculator, icon_globe, icon_brush, icon_game, icon_clock, icon_calendar, icon_music.",
];

const TARGETS = {
  real16: {
    id: "real16",
    label: "16-bit Real Mode",
    templateDirs: [path.join(TEMPLATE_ROOT, "16bit")],
    builder: "floppy",
    mode: "flat",
    qemu: "qemu-system-i386",
    browserBootable: true,
    maxKernelBytes: 480 * 1024,
    bootWaitMs: 3000,
    brief: [
      "CPU is in 16-bit real mode. BIOS interrupts (int 0x10, 0x13, 0x16, 0x1A) are available.",
      "boot.asm is the 512-byte boot sector at 0x7C00; it must load KERNEL_SECTORS sectors (passed with -DKERNEL_SECTORS) from LBA 1 to 0000:8000 and jump there.",
      "kernel.asm is assembled with `nasm -f bin` and must start with `[org 0x8000]`. It can be large (up to ~400KB) and split into .inc files pulled in with %include \"name.inc\".",
      "Files you may produce: boot.asm, kernel.asm and extra .inc files.",
    ],
  },
  prot32: {
    id: "prot32",
    label: "32-bit Protected Mode",
    templateDirs: [path.join(TEMPLATE_ROOT, "sdk"), path.join(TEMPLATE_ROOT, "os32")],
    builder: "floppy",
    mode: "linked",
    nasmFormat: "elf32",
    cflags: ["-m32", ...COMMON_CFLAGS],
    ldEmulation: "elf_i386",
    qemu: "qemu-system-i386",
    browserBootable: true,
    maxKernelBytes: 380 * 1024,
    bootWaitMs: 4000,
    brief: ["Target: i386 32-bit protected mode, compiled with gcc -m32.", ...SDK_BRIEF],
  },
  long64: {
    id: "long64",
    label: "64-bit Long Mode",
    templateDirs: [path.join(TEMPLATE_ROOT, "sdk"), path.join(TEMPLATE_ROOT, "os64")],
    builder: "floppy",
    mode: "linked",
    nasmFormat: "elf64",
    cflags: ["-m64", "-mno-red-zone", "-mcmodel=small", "-mgeneral-regs-only", ...COMMON_CFLAGS],
    ldEmulation: "elf_x86_64",
    qemu: "qemu-system-x86_64",
    // v86 emulates 32-bit x86 only, so long-mode images are verified in QEMU only.
    browserBootable: false,
    maxKernelBytes: 380 * 1024,
    bootWaitMs: 4000,
    brief: ["Target: x86_64 long mode (identity-mapped first 4GB), compiled with gcc -m64 -mno-red-zone -mgeneral-regs-only.", ...SDK_BRIEF],
  },
  linux64: {
    id: "linux64",
    label: "Linux Forge (64-bit)",
    templateDirs: [path.join(TEMPLATE_ROOT, "linux64")],
    builder: "linux",
    linuxBase: LINUX_BASE,
    qemu: "qemu-system-x86_64",
    browserBootable: false,
    bootWaitMs: 9000,
    brief: [
      "This target customises a real 64-bit Linux kernel instead of writing one from scratch. The engine supplies the kernel (bzImage) and a static BusyBox that provides /bin/sh and ~300 standard commands.",
      "Files live under two folders. rootfs/... files are copied into the root filesystem as-is (scripts are made executable when they start with #!). src/NAME.c (plus src/*.h) is compiled with `gcc -static -O2` into /usr/bin/NAME, with full glibc available (stdio, stdlib, string, unistd, termios, sys/ioctl, linux/fb.h, ...).",
      "Boot flow: the kernel runs rootfs/init (PID 1), which mounts /proc /sys /dev, runs /etc/kc/rc and then keeps a shell or your app alive on tty1. The console is a 1024x768 framebuffer (/dev/fb0, usually 24 or 32 bpp) with the Linux text console on top, so programs can use ANSI escape codes for colour TUIs, or draw pixels on /dev/fb0 (see src/kcfb.h).",
      "Keep init robust: if your app exits, fall back to a shell. Do not depend on networking or packages that are not in BusyBox.",
    ],
  },
};

const TARGET_ALIASES = {
  16: "real16", "16bit": "real16", real: "real16",
  32: "prot32", "32bit": "prot32", protected: "prot32",
  64: "long64", "64bit": "long64", long: "long64",
  linux: "linux64", forge: "linux64",
};

function getTier(name) {
  const key = TARGETS[name] ? name : TARGET_ALIASES[String(name).toLowerCase()];
  if (!key) throw new Error(`Unknown target "${name}". Use one of: ${Object.keys(TARGETS).join(", ")}`);
  return TARGETS[key];
}

module.exports = { TIERS: TARGETS, TARGETS, getTier, TEMPLATE_ROOT };
