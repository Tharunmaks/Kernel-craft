# KernelCraft

Prototype of an AI OS foundry: describe an operating system in plain English, and KernelCraft writes the boot sector and kernel, builds a 1.44MB floppy image, boots it in a headless VM, has a vision model check the screen, repairs the code if needed, and then runs the result in your browser.

```
prompt ──▶ Agent 1: generator ──▶ build (nasm / gcc / ld) ──▶ floppy.img
               ▲                                                  │
               │ build errors, critic issues                      ▼
               └──── Agent 2: vision critic ◀── screenshot ◀── headless QEMU
                                                                  │ verified
                                                                  ▼
                                                     v86 (WebAssembly) in the browser
```

## Quick start

```bash
# toolchain (Debian/Ubuntu)
sudo apt install nasm gcc binutils qemu-system-x86

npm install            # also downloads the SeaBIOS images v86 needs
export ANTHROPIC_API_KEY=...   # optional, see "Providers"
npm start              # http://localhost:8086
npm test               # builds and boots every template in QEMU
```

Without an API key the server runs in **offline mode**: it personalises the stock template for the chosen tier (OS name from "called X", colour theme from the prompt) and checks screenshots with pixel statistics only. That is enough to demo the whole loop.

## The IDE (`public/`)

- **Left:** prompt, tier selector, and the Agent Thought Log, streamed live from the server.
- **Center:** the v86 emulator screen with CPU state, MIPS, FPS, video mode, memory and image size, plus **Export .IMG**, **Reboot** and a **Source** tab showing the generated files.
- **Bottom:** one card per verification pass with the QEMU screenshot and the critic's verdict. Click a card for the full issue list.
- **Boot sample** builds and boots the stock template for the selected tier, with no LLM involved.

## Tiers

| Tier | Plan | Build | Runs in browser |
|---|---|---|---|
| `real16` 16-bit Real Mode | Free | `boot.asm` + `kernel.asm` (`nasm -f bin`), kernel at `0x8000` | yes |
| `prot32` 32-bit Protected Mode | Pro | `boot.asm` + `entry.asm` (elf32) + `kernel.c` (`gcc -m32 -ffreestanding`), linked at `0x10000` | yes |
| `long64` 64-bit Long Mode | Enterprise | same, with `entry.asm` building page tables and entering long mode, `gcc -m64` | no: v86 emulates 32-bit x86 only, so these are verified in `qemu-system-x86_64` and exported |

The templates in `templates/` are working reference systems: a text-mode shell for 16-bit, and a VGA 320x200 desktop with a taskbar, windows and a keyboard-driven terminal for 32/64-bit. The generator receives them as a starting point. The boot sector is passed `-DKERNEL_SECTORS=n` by the engine, so kernels can grow without touching the loader. The linker script is engine-owned.

## API

`POST /api/build-os` with `{ "prompt": "...", "tier": "real16" | "prot32" | "long64", "maxPasses": 1-3 }`

By default the response is NDJSON, one event per line:

- `{"type":"log","agent":"generator|builder|runner|critic|system","message":"..."}`
- `{"type":"pass","pass":1,"stage":"build|boot","screenshot":"data:image/png;base64,...","verdict":{"pass":false,"summary":"...","issues":[...]}}`
- `{"type":"result","verified":true,"finalPass":2,"image":"<base64 floppy.img>","files":{...},"passes":[...]}`

Send `Accept: application/json` to get only the final result (with screenshots) as one JSON object.

`GET /api/sample/<tier>.img` returns the stock template image. `GET /api/config` returns the provider and tiers.

## How a pass works (`lib/pipeline.js`)

1. **Synthesis:** the provider returns complete files in `<file name="...">` blocks.
2. **Build:** sources are validated (flat file names, no `incbin`, includes only of sibling files), then assembled, compiled and linked with timeouts. The boot sector must be exactly 512 bytes with the `0xAA55` signature.
3. **Boot:** `qemu-system-i386 -fda floppy.img -display none -monitor stdio -no-reboot`, and after 3 seconds a `screendump` from the QEMU monitor, converted from PPM to PNG in `lib/png.js`. A triple fault ends the VM early and is reported as a crash.
4. **Critique:** blank screens and crashes fail without a model call. Otherwise the screenshot, pixel statistics and serial output go to the vision critic, which returns pass/fail plus actionable issues.
5. **Repair:** build logs or critic issues go back to the generator with the previous files, up to 3 passes. The response carries the verified image, or the last one that booted to something visible.

## Providers

`lib/providers/` holds pluggable model backends with two methods, `generate()` and `critique()`. Prompts live in `lib/prompts.js` so they are shared.

- `anthropic` (default when `ANTHROPIC_API_KEY` is set): Claude Opus 5.5 (`claude-opus-5-5`) with adaptive thinking, streaming, high effort for code and medium for the critic. It opts into server-side refusal fallbacks (`fallbacks: "default"`), because low-level systems code can occasionally trip a safety classifier. The fallback re-runs the request on another model rather than failing.
- `offline`: template personalisation plus heuristic checks.

To add another vendor (e.g. Gemini), add a file that implements the two methods and register it in `lib/providers/index.js`.

| Env var | Default | |
|---|---|---|
| `KC_PROVIDER` | `anthropic` if a key is set, else `offline` | |
| `KC_MODEL` | `claude-opus-5-5` | generator model |
| `KC_CRITIC_MODEL` | same as `KC_MODEL` | vision critic model |
| `KC_BOOT_WAIT_MS` | `3000` | delay before the screenshot |
| `KC_MAX_BUILDS` | `2` | concurrent builds |
| `PORT` | `8086` | |

## Security note

Prompts are user input, so generated code is untrusted. The engine blocks the obvious ways of reading host files into an image and runs every tool with a timeout and a minimal environment. But nasm, gcc, ld and QEMU still run directly on the host. Before exposing this publicly, run builds inside a throwaway container or microVM with no network.
