# KernelCraft

An AI OS foundry. Describe an operating system in plain English. KernelCraft's agents plan it, write it, compile it into a bootable image, boot it in a headless VM, check the screen with a vision model, repair what's broken, and run the result in your browser.

```
prompt ─▶ architect ─▶ writers (parallel) ─▶ nasm / gcc / ld ─▶ floppy.img or Linux initramfs
              ▲              ▲   compile errors ◀─┘                         │
              │              └── fixer ◀── critic issues ◀── screenshot ◀── headless QEMU
              │                                                             │ verified
        "Change this OS"                                       v86 in the browser / export
```

## Quick start

```bash
# toolchain (Debian/Ubuntu)
sudo apt install nasm gcc gcc-multilib binutils qemu-system-x86

npm install                 # also downloads the SeaBIOS images v86 needs
npm run setup:linux         # optional: kernel + BusyBox for Linux Forge (Max plan)
export ANTHROPIC_API_KEY=...  # optional, see "AI providers"
KC_DEV_BILLING=1 npm start  # http://localhost:8086, plans activate without payment
npm test
```

Without an API key the server runs in **offline mode**: it personalises the stock templates (OS name from "called X", colour theme from the prompt) and checks screenshots with pixel statistics. That's enough to demo the whole product.

## Build targets

| Target | What the AI writes | Runs in browser | Plan |
|---|---|---|---|
| **16-bit real mode** | NASM boot sector + kernel (BIOS, text/VGA) | yes | Plus |
| **32-bit protected mode** | C on the KernelCraft SDK | yes | Pro |
| **64-bit long mode** | the same SDK, x86_64 with paging | QEMU screenshot + export (v86 is 32-bit only) | Max |
| **Linux Forge** | init scripts, config and C programs on a real Linux 6.8 kernel + BusyBox | QEMU screenshot + `.tar.gz` export with `run-qemu.sh` | Max |

### The KernelCraft SDK (`templates/sdk`)

A small graphical OS the AI builds on instead of starting from nothing every time: 800x600 32-bit framebuffer (Bochs VBE), PS/2 keyboard and mouse, IDT/PIC/PIT, a heap, a RAM filesystem, a window manager (drag, minimise, maximise, taskbar, start menu, desktop icons, Alt+Tab, toasts), a terminal with a shell, and apps (Files, Notepad, System Monitor, Calculator, Settings with themes). The full API is in `kc.h`; the Docs page in the app shows it too.

The AI adds features through three extension points that need no edits to the core:

```c
KC_APP(paint, "Paint", icon_info, paint_open);   // desktop icon + start menu entry
KC_COMMAND(hi, "say hi", cmd_hi);                // terminal command
KC_BOOT_HOOK(setup);                             // theme, wallpaper, files at boot
```

It can also rewrite any SDK file. Memory map: font at 0x6000, kernel at 0x10000 (linker-checked to end below 0x70000), 64-bit page tables at 0x70000, stack at 0x90000, heap from 2 MB to the end of RAM.

## Virtual hardware

The Studio's **Hardware** panel picks the machine each OS is built for: CPU cores (1-8), CPU type (basic QEMU CPU or "modern" with every emulated feature), RAM (32 MB-2 GB), graphics memory (8-64 MB) and screen resolution (640x480 up to 1920x1080). Settings are saved with the project (`lib/hardware.js`) and applied to:

- **The test VM**: `-m`, `-smp`, `-cpu`, `-device VGA,vgamem_mb=…`.
- **The kernel**: SDK targets get an engine-generated `kc_config.c` (`kc_hw`), so `gfx_init` uses the chosen resolution. Monitor and Settings show the CPU brand and core count (CPUID), RAM, graphics memory and resolution.
- **The browser emulator**: v86 gets the same RAM (capped at 1 GB in the browser tab) and graphics memory.
- **Linux Forge**: kernel `vga=` mode, console size, and the exported `run-qemu.sh`.

The SDK runs on the boot CPU only. Extra cores are visible to the OS, and the AI can be asked to add SMP. Linux uses all cores.

## App store

The **Apps** tab adds ready-made apps to 32-bit and 64-bit desktops with one click. Each app is one self-registering C file in `templates/apps/`, and adding or removing one rebuilds the OS without an AI call:

| App | What it does |
|---|---|
| Web | Browser with the **Seek** search engine, address bar, back/forward and links. It browses built-in `kc://` sites and every file on the OS (`file:///…`). There's no network driver yet. |
| Paint | Brush, eraser, line, rectangle, circle and fill tools, 20 colours, undo, save/open (`.ppm`) |
| Snake, Mines | Games with sound, a timer, difficulty levels and a saved high score |
| Clock, Calendar | Analog/digital clock with stopwatch; month view with notes per day |
| Piano | Two octaves on the PC speaker with a demo tune |

**Make any app with AI** turns a one-line description into a "Change this OS" request, and works for Linux Forge too.

## Big-OS mode

On Pro (up to 10 files) and Max (up to 20 files), generation is split across agents so one OS can be far bigger than one model reply:

1. **Architect** reads the prompt, the SDK header and an index of existing files, and returns a JSON plan: the OS name, a summary, and which files to create or modify.
2. **Writers** implement the planned files: headers first, one by one, so later files see them, then everything else four at a time.
3. **Repair**: compiler errors are mapped back to the files that caused them and only those are rewritten (up to 2 rounds per pass). Link errors and critic findings go to a **fixer** agent that chooses which files to rewrite.
4. The **vision critic** checks the QEMU screenshot against the prompt; failures start another pass (3 on Plus, 4 on Pro, 5 on Max).

**Change this OS** reruns the same loop on a saved project with your change request, so an OS can be grown feature by feature. The Code tab lets you edit any file and **Rebuild** without AI.

## Plans and payments

| Plan | Price / 30 days | Includes |
|---|---|---|
| Free | ₹0 | v86 emulator, sample OSes, boot your own `.img` |
| Plus | ₹700 | AI 16-bit builds, 15 a day |
| Pro | ₹2,000 | + 32-bit SDK desktops, big-OS mode (10 files), 40 a day |
| Max | ₹10,000 | + 64-bit and Linux Forge, big-OS mode (20 files), 100 a day |

Plans and limits live in `lib/plans.js`. Payments use **Razorpay** (UPI, cards, net banking, wallets):

- The server creates the Razorpay Order, with the amount taken from `lib/plans.js` and never from the browser.
- After Checkout, `/api/billing/verify` checks `HMAC_SHA256(order_id|payment_id, key_secret)` before activating the plan.
- `/api/billing/webhook` handles `order.paid` / `payment.captured`, verified with `X-Razorpay-Signature` and checked against the expected amount, so a plan activates even if the browser closes mid-payment. Activation is idempotent.

| Variable | Purpose |
|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | API keys from the Razorpay dashboard |
| `RAZORPAY_WEBHOOK_SECRET` | secret for the webhook at `https://<your-host>/api/billing/webhook` (events: `order.paid`, `payment.captured`) |
| `KC_DEV_BILLING=1` | local development only: activates plans without payment when Razorpay keys are not set |

Accounts use scrypt password hashes and an HttpOnly session cookie. Data lives in `data/` (`KC_DATA_DIR`): `db.json` for users, sessions, payments and usage, and one directory per project for sources, images and screenshots. Swap `lib/store.js` for a real database before scaling past one server.

## AI providers

`lib/providers/` holds pluggable providers (`KC_PROVIDER=anthropic|offline`). The Claude provider uses `claude-opus-5-5` by default (`KC_MODEL`, `KC_CRITIC_MODEL` override), streaming with adaptive thinking and server-side model fallbacks. To add another vendor, implement `complete()`, `generate()` and `critique()` with `lib/prompts.js` and register it in `lib/providers/index.js`.

## Security

The prompt is user input, so generated code is untrusted:

- File names are restricted (flat names for kernels; `rootfs/…` and `src/*.c|h` for Linux Forge). There is no `incbin`, no inline-asm `.include`, only sibling-header includes, and no system headers in freestanding kernels.
- Every tool runs with a timeout, and the guest only ever runs inside QEMU.
- Compilers still run on the host. **In production, run builds in a throwaway container or microVM** (no network, CPU and memory limits, read-only root) and run the web server separately.

## Layout

```
server.js              HTTP API, auth, billing, projects, build jobs (NDJSON streaming)
lib/pipeline.js        generate → build → boot → critique loop
lib/bigmode.js         architect / writers / fixer
lib/toolchain.js       floppy and Linux builders, QEMU boot + screenshot, validation
lib/tiers.js           build targets     lib/plans.js     plans and limits
lib/billing.js         Razorpay          lib/auth.js      accounts and sessions
lib/archive.js         cpio + tar        lib/png.js       PPM → PNG
lib/hardware.js        virtual hardware  lib/apps.js      app catalog
templates/             16bit, sdk (+ os32/os64 entry and linker scripts), apps, linux64
public/                the web app (home, studio, projects, pricing, docs)
```
