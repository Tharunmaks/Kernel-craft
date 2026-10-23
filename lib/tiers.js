// Tier definitions: what each subscription tier builds, how, and where it runs.
const path = require("path");

const TEMPLATE_ROOT = path.join(__dirname, "..", "templates");

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

const TIERS = {
  real16: {
    id: "real16",
    label: "16-bit Real Mode",
    plan: "Free / Hobby",
    templateDir: path.join(TEMPLATE_ROOT, "16bit"),
    // Flat NASM kernel: boot.asm + kernel.asm, both -f bin.
    mode: "flat",
    qemu: "qemu-system-i386",
    browserBootable: true,
    loadAddress: 0x8000,
    maxKernelBytes: 480 * 1024,
    brief: [
      "CPU is in 16-bit real mode. BIOS interrupts (int 0x10, 0x13, 0x16, 0x1A) are available.",
      "boot.asm is the 512-byte boot sector at 0x7C00; it must load KERNEL_SECTORS sectors (passed with -DKERNEL_SECTORS) from LBA 1 to 0000:8000 and jump there.",
      "kernel.asm is assembled with `nasm -f bin` and must start with `[org 0x8000]`.",
      "Files you may produce: boot.asm, kernel.asm and extra .inc files pulled in with %include \"name.inc\".",
    ],
  },
  prot32: {
    id: "prot32",
    label: "32-bit Protected Mode",
    plan: "Pro",
    templateDir: path.join(TEMPLATE_ROOT, "32bit"),
    // Linked kernel: entry.asm (elf32) + *.c (gcc -m32) linked at 0x10000 with link.ld.
    mode: "linked",
    nasmFormat: "elf32",
    cflags: ["-m32", ...COMMON_CFLAGS],
    ldEmulation: "elf_i386",
    qemu: "qemu-system-i386",
    browserBootable: true,
    loadAddress: 0x10000,
    maxKernelBytes: 448 * 1024,
    brief: [
      "boot.asm (512-byte boot sector) sets VGA mode 13h (320x200x256, framebuffer 0xA0000), copies the BIOS 8x8 font to phys 0x6000 (256 glyphs x 8 bytes), loads the kernel to 0x10000, enables A20, loads a flat GDT (code 0x08, data 0x10) and jumps to 0x10000 in 32-bit protected mode with ESP=0x90000.",
      "entry.asm is assembled with `nasm -f elf32`, lives in section .text.entry, zeroes .bss using __bss_start/__bss_end and calls kmain().",
      "kernel.c (and any other .c / .h files) is compiled with gcc -m32 -ffreestanding -nostdlib -nostdinc -O2: no libc and no system headers. Define your own memset/memcpy; gcc may emit calls to them.",
      "The engine links everything with its own linker script at 0x10000 into a flat binary. No interrupts/IDT are set up: poll hardware (keyboard port 0x60/0x64, CMOS 0x70/0x71) instead, or install your own IDT.",
      "Files you may produce: boot.asm, entry.asm, kernel.c, plus extra .c/.h files.",
    ],
  },
  long64: {
    id: "long64",
    label: "64-bit Long Mode",
    plan: "Enterprise / Education",
    templateDir: path.join(TEMPLATE_ROOT, "64bit"),
    mode: "linked",
    nasmFormat: "elf64",
    cflags: ["-m64", "-mno-red-zone", "-mcmodel=small", "-mgeneral-regs-only", ...COMMON_CFLAGS],
    ldEmulation: "elf_x86_64",
    qemu: "qemu-system-x86_64",
    // v86 only emulates 32-bit x86, so long-mode images are verified in QEMU only.
    browserBootable: false,
    loadAddress: 0x10000,
    maxKernelBytes: 448 * 1024,
    brief: [
      "boot.asm is the same as the 32-bit tier: mode 13h, font at 0x6000, kernel at 0x10000, jump in 32-bit protected mode.",
      "entry.asm ([bits 32] then [bits 64], assembled with `nasm -f elf64`) identity-maps the first 1GB with 2MB pages (tables at 0x1000-0x3FFF), enables PAE + EFER.LME + paging, loads a 64-bit GDT, zeroes .bss and calls kmain().",
      "kernel.c is compiled with gcc -m64 -mno-red-zone -mcmodel=small -mgeneral-regs-only -ffreestanding -nostdlib -nostdinc -O2. Define your own memset/memcpy.",
      "Files you may produce: boot.asm, entry.asm, kernel.c, plus extra .c/.h files.",
    ],
  },
};

const TIER_ALIASES = {
  16: "real16", "16bit": "real16", real: "real16",
  32: "prot32", "32bit": "prot32", protected: "prot32",
  64: "long64", "64bit": "long64", long: "long64",
};

function getTier(name) {
  const key = TIERS[name] ? name : TIER_ALIASES[String(name).toLowerCase()];
  if (!key) throw new Error(`Unknown tier "${name}". Use one of: ${Object.keys(TIERS).join(", ")}`);
  return TIERS[key];
}

module.exports = { TIERS, getTier };
