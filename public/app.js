// KernelCraft IDE: talks to /api/build-os and boots results in v86.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    prompt: $("prompt"), build: $("build"), sample: $("sample"), log: $("log"),
    exportBtn: $("export"), restart: $("restart"), overlay: $("overlay"), preview: $("preview"),
    screen: $("screen_container"), gallery: $("gallery"), passSummary: $("pass-summary"),
    provider: $("provider"), fileTabs: $("file-tabs"), source: $("source"),
    lightbox: $("lightbox"), lightboxImg: $("lightbox-img"), lightboxText: $("lightbox-text"),
    m: { cpu: $("m-cpu"), mips: $("m-mips"), fps: $("m-fps"), video: $("m-video"), mem: $("m-mem"), image: $("m-image") },
  };

  const MEMORY_MB = 32;
  const VGA_MB = 8;

  let tiers = {};
  let emulator = null;
  let currentImage = null; // { bytes: Uint8Array, name, browserBootable }
  let building = false;

  const selectedTier = () => document.querySelector('input[name="tier"]:checked').value;

  // ------------------------------------------------------------ logging ---
  function log(agent, message) {
    const line = document.createElement("div");
    line.className = "line";
    const tag = document.createElement("span");
    tag.className = `agent ${agent}`;
    tag.textContent = `[${agent}]`;
    line.append(tag, document.createTextNode(message));
    el.log.append(line);
    el.log.scrollTop = el.log.scrollHeight;
  }
  $("clear-log").onclick = () => (el.log.textContent = "");

  // ----------------------------------------------------------- emulator ---
  async function stopEmulator() {
    if (!emulator) return;
    const old = emulator;
    emulator = null;
    try { await old.destroy(); } catch (err) { console.warn(err); }
  }

  async function bootImage(bytes, label) {
    await stopEmulator();
    el.preview.hidden = true;
    el.screen.hidden = false;
    el.overlay.hidden = true;
    el.m.video.textContent = "–";
    emulator = new V86({
      wasm_path: "/vendor/v86.wasm",
      memory_size: MEMORY_MB * 1024 * 1024,
      vga_memory_size: VGA_MB * 1024 * 1024,
      screen: { container: el.screen, use_graphical_text: true },
      bios: { url: "/vendor/bios/seabios.bin" },
      vga_bios: { url: "/vendor/bios/vgabios.bin" },
      fda: { buffer: bytes.slice().buffer },
      autostart: true,
    });
    emulator.add_listener("screen-set-size", ([w, h, bpp]) => {
      el.m.video.textContent = bpp ? `${w}×${h}×${bpp}` : `${w}×${h} text`;
    });
    emulator.add_listener("emulator-started", () => log("system", `v86 booted ${label}.`));
    el.m.mem.textContent = `${MEMORY_MB} MB + ${VGA_MB} MB VGA`;
  }

  function showPreviewOnly(dataUrl, message) {
    stopEmulator();
    el.screen.hidden = true;
    el.preview.src = dataUrl || "";
    el.preview.hidden = !dataUrl;
    el.overlay.hidden = false;
    el.overlay.innerHTML = "";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = message;
    el.overlay.append(p);
    el.overlay.style.background = dataUrl ? "linear-gradient(transparent 70%, rgba(5,8,14,.9))" : "";
    el.overlay.style.justifyContent = dataUrl ? "flex-end" : "center";
  }

  el.restart.onclick = () => {
    if (currentImage?.browserBootable) bootImage(currentImage.bytes, currentImage.name);
  };
  el.screen.addEventListener("click", () => el.screen.querySelector("canvas")?.focus?.());

  // Metrics: instructions/sec from the emulator, FPS from the page render loop.
  let lastInstr = 0, frames = 0;
  (function frame() { frames++; requestAnimationFrame(frame); })();
  setInterval(() => {
    const running = emulator && emulator.is_running();
    el.m.cpu.textContent = !emulator ? "idle" : running ? "running" : "stopped";
    el.m.cpu.style.color = running ? "var(--pass)" : "";
    if (running) {
      const instr = emulator.get_instruction_counter();
      const delta = instr >= lastInstr ? instr - lastInstr : instr + 2 ** 32 - lastInstr;
      lastInstr = instr;
      el.m.mips.textContent = (delta / 1e6).toFixed(1);
      el.m.fps.textContent = frames;
    } else {
      el.m.mips.textContent = "–";
      el.m.fps.textContent = "–";
    }
    frames = 0;
  }, 1000);

  // --------------------------------------------------------------- export ---
  function setImage(bytes, name, browserBootable) {
    currentImage = { bytes, name, browserBootable };
    el.exportBtn.disabled = false;
    el.m.image.textContent = `${(bytes.length / 1024).toFixed(0)} KB`;
  }

  el.exportBtn.onclick = () => {
    if (!currentImage) return;
    const url = URL.createObjectURL(new Blob([currentImage.bytes], { type: "application/octet-stream" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: currentImage.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // --------------------------------------------------------------- source ---
  function showSource(files) {
    el.fileTabs.innerHTML = "";
    const names = Object.keys(files || {});
    if (!names.length) {
      el.source.textContent = "No source for this image.";
      return;
    }
    const select = (name, btn) => {
      el.fileTabs.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      el.source.textContent = files[name];
    };
    names.forEach((name, i) => {
      const btn = document.createElement("button");
      btn.textContent = name;
      btn.onclick = () => select(name, btn);
      el.fileTabs.append(btn);
      if (i === 0) select(name, btn);
    });
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      $("tab-display").hidden = tab.dataset.tab !== "display";
      $("tab-source").hidden = tab.dataset.tab !== "source";
    };
  });

  // -------------------------------------------------------------- gallery ---
  function resetGallery() {
    el.gallery.innerHTML = "";
    el.passSummary.textContent = "";
  }

  function addPassCard(ev) {
    const ok = ev.verdict?.pass;
    const card = document.createElement("div");
    card.className = `card ${ok ? "pass" : "fail"}`;
    const header = document.createElement("header");
    const title = document.createElement("span");
    title.textContent = `Pass ${ev.pass} · ${ev.stage === "build" ? "build" : "boot"}`;
    const badge = document.createElement("span");
    badge.className = `badge ${ok ? "pass" : "fail"}`;
    badge.textContent = ok ? "PASS" : "FAIL";
    header.append(title, badge);
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (ev.screenshot) thumb.style.backgroundImage = `url(${ev.screenshot})`;
    else thumb.textContent = ev.stage === "build" ? "build error" : "no screenshot";
    const summary = document.createElement("p");
    summary.textContent = ev.verdict?.summary || "";
    card.append(header, thumb, summary);
    card.onclick = () => openLightbox(ev);
    el.gallery.append(card);
    card.scrollIntoView({ behavior: "smooth", inline: "end", block: "nearest" });
  }

  function openLightbox(ev) {
    el.lightboxImg.hidden = !ev.screenshot;
    el.lightboxImg.src = ev.screenshot || "";
    el.lightboxText.innerHTML = "";
    const h = document.createElement("h3");
    h.textContent = `Pass ${ev.pass}: ${ev.verdict?.pass ? "PASS" : "FAIL"} — ${ev.verdict?.summary || ""}`;
    el.lightboxText.append(h);
    if (ev.verdict?.issues?.length) {
      const ul = document.createElement("ul");
      for (const issue of ev.verdict.issues) {
        const li = document.createElement("li");
        const pre = document.createElement("pre");
        pre.style.whiteSpace = "pre-wrap";
        pre.textContent = issue;
        li.append(pre);
        ul.append(li);
      }
      el.lightboxText.append(ul);
    }
    if (ev.stats) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = `Image stats: ${JSON.stringify(ev.stats)}`;
      el.lightboxText.append(p);
    }
    el.lightbox.showModal();
  }

  // ---------------------------------------------------------------- build ---
  function setBusy(busy) {
    building = busy;
    el.build.disabled = busy;
    el.sample.disabled = busy;
    el.build.textContent = busy ? "Building…" : "Build OS";
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function* ndjson(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line);
      }
    }
    if (buf.trim()) yield JSON.parse(buf);
  }

  el.build.onclick = async () => {
    const prompt = el.prompt.value.trim();
    if (!prompt || building) return;
    const tier = selectedTier();
    setBusy(true);
    resetGallery();
    log("system", `Build requested: ${tiers[tier]?.label || tier}`);
    const screenshots = {};
    try {
      const res = await fetch("/api/build-os", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, tier }),
      });
      if (!res.ok && !res.headers.get("content-type")?.includes("ndjson")) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      for await (const ev of ndjson(res)) {
        if (ev.type === "log") log(ev.agent, ev.message);
        else if (ev.type === "pass") {
          screenshots[ev.pass] = ev.screenshot;
          addPassCard(ev);
        } else if (ev.type === "error") log("error", ev.message);
        else if (ev.type === "result") handleResult(ev, screenshots);
      }
    } catch (err) {
      log("error", err.message);
    } finally {
      setBusy(false);
    }
  };

  function handleResult(result, screenshots) {
    const n = result.passes.length;
    el.passSummary.textContent = result.verified
      ? `verified on pass ${result.finalPass} of ${n}`
      : `not verified after ${n} pass${n === 1 ? "" : "es"}`;
    if (!result.image) {
      log("error", "No bootable image was produced.");
      return;
    }
    const bytes = base64ToBytes(result.image);
    setImage(bytes, `kernelcraft-${result.tier}.img`, result.browserBootable);
    showSource(result.files);
    if (result.browserBootable) {
      bootImage(bytes, `pass ${result.finalPass} image`);
    } else {
      showPreviewOnly(
        screenshots[result.finalPass],
        "QEMU screenshot. v86 emulates 32-bit x86 only, so long-mode images can't run in the browser yet. Export the .img and run: qemu-system-x86_64 -fda kernelcraft-long64.img"
      );
    }
  }

  el.sample.onclick = async () => {
    const tier = selectedTier();
    setBusy(true);
    try {
      log("system", `Building stock ${tiers[tier]?.label || tier} template…`);
      const res = await fetch(`/api/sample/${tier}.img`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      setImage(bytes, `kernelcraft-${tier}-sample.img`, tiers[tier]?.browserBootable);
      showSource({});
      if (tiers[tier]?.browserBootable) bootImage(bytes, "sample image");
      else showPreviewOnly(null, "Sample built. v86 can't run 64-bit long mode; use Export .IMG and boot it with qemu-system-x86_64.");
    } catch (err) {
      log("error", err.message);
    } finally {
      setBusy(false);
    }
  };

  // ----------------------------------------------------------------- init ---
  fetch("/api/config")
    .then((r) => r.json())
    .then((cfg) => {
      el.provider.textContent = `LLM: ${cfg.provider} · ${cfg.maxPasses} critic passes max`;
      for (const t of cfg.tiers) tiers[t.id] = t;
    })
    .catch(() => (el.provider.textContent = "server unreachable"));

  if (typeof V86 === "undefined") log("error", "libv86.js failed to load; run npm install.");
})();
