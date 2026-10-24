// KernelCraft web app: routing, accounts, pricing + Razorpay, projects, and
// the Studio (AI builds, code editor, v86 emulator, serial console).
(() => {
  const $ = (id) => document.getElementById(id);
  const h = (tag, props = {}, ...children) => {
    const el = Object.assign(document.createElement(tag), props);
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  };

  const state = {
    config: null,
    me: null,                 // { user, plan, usage } or { user: null }
    target: "prot32",
    project: null,            // saved project meta
    files: {},                // current sources (editable)
    savedFiles: {},           // last built sources
    activeFile: null,
    image: null,              // { bytes, name, browserBootable }
    artifacts: [],            // names of downloadable artifacts for the project
    building: false,
    hardware: null,           // { resolution, ramMB, vramMB, cpus, cpuModel }
    selectedApps: new Set(),  // catalog apps picked before the first build
  };

  const IDEAS = {
    real16: ["A DOS-style shell with a file list and a snake game", "A retro BIOS setup screen with menus", "A hacker terminal with a matrix rain intro"],
    prot32: ["A Windows-95-style desktop with a start menu, file explorer and paint app", "A macOS-like dock with a clock widget and notes", "A neon cyberpunk OS with a music visualiser and a snake game"],
    long64: ["A 64-bit workstation OS with a system monitor, process list and a text editor", "A kiosk OS with a big touch-style app launcher"],
    linux64: ["A Linux distro for students with a menu-driven study timer and notes app", "A retro gaming Linux that boots into a launcher of terminal games", "A server dashboard distro that shows live CPU and memory graphs"],
  };

  // The GitHub Pages build sets window.KC_STATIC: no server, so the app runs
  // the emulator with prebuilt images and explains that builds need the server.
  const STATIC = Boolean(window.KC_STATIC);
  const SERVER_NEEDED = "This GitHub Pages demo runs the emulator only. Accounts and AI builds need the KernelCraft server: use “Run the full app in Codespaces”.";

  // ------------------------------------------------------------------ api ---
  async function staticApi(path) {
    if (path === "/api/config") return (await fetch("static.json")).json();
    if (path === "/api/me") return { user: null };
    if (path === "/api/sdk") return { files: { "kc.h": await (await fetch("sdk/kc.h")).text() } };
    throw new Error(SERVER_NEEDED);
  }

  async function api(path, { method = "GET", body } = {}) {
    if (STATIC) return staticApi(path);
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
    return data;
  }

  function toast(text, ms = 3500) {
    const t = $("toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), ms);
  }

  // --------------------------------------------------------------- router ---
  const VIEWS = ["home", "studio", "projects", "pricing", "docs"];
  function route() {
    const [, view = "home", arg] = location.hash.match(/^#\/?([a-z]*)\/?(.*)$/) || [];
    const name = VIEWS.includes(view) ? view : "home";
    for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
    document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
    if (name === "projects") renderProjects();
    if (name === "pricing") renderPlans();
    if (name === "studio" && arg && arg !== state.project?.id) openProject(arg);
  }
  window.addEventListener("hashchange", route);

  // -------------------------------------------------------------- account ---
  function plan() { return state.me?.plan || { id: "free", targets: [] }; }

  function renderAccount() {
    const box = $("account");
    box.innerHTML = "";
    if (STATIC) {
      box.append(h("a", { className: "button small", href: state.config?.repo || "#", target: "_blank", rel: "noopener", textContent: "GitHub" }));
    } else if (!state.me?.user) {
      box.append(h("button", { className: "primary small", textContent: "Sign in", onclick: () => openAuth("login") }));
    } else {
      box.append(
        h("span", { className: "plan-badge", textContent: state.me.plan.name, title: "Your plan" }),
        h("span", { className: "muted", textContent: state.me.user.name }),
        h("button", { className: "small", textContent: "Sign out", onclick: signOut }),
      );
    }
    renderTargets();
    renderUsage();
  }

  async function refreshMe() {
    state.me = await api("/api/me").catch(() => ({ user: null }));
    renderAccount();
  }

  async function signOut() {
    await api("/api/auth/logout", { method: "POST", body: {} });
    state.me = { user: null };
    newProject();
    renderAccount();
    route();
    toast("Signed out");
  }

  let authMode = "login";
  let afterAuth = null;
  function openAuth(mode = "login", then = null) {
    authMode = mode;
    afterAuth = then;
    const signup = mode === "signup";
    $("auth-title").textContent = signup ? "Create your account" : "Sign in";
    $("auth-submit").textContent = signup ? "Create account" : "Sign in";
    $("auth-switch-text").textContent = signup ? "Already have an account?" : "New here?";
    $("auth-switch").textContent = signup ? "Sign in" : "Create an account";
    document.querySelector(".name-field").hidden = !signup;
    $("auth-form").password.autocomplete = signup ? "new-password" : "current-password";
    $("auth-error").textContent = "";
    $("auth-dialog").showModal();
  }
  $("auth-switch").onclick = () => openAuth(authMode === "login" ? "signup" : "login", afterAuth);
  $("auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      state.me = await api(`/api/auth/${authMode}`, { method: "POST", body: { email: f.email.value, password: f.password.value, name: f.name.value } });
      $("auth-dialog").close();
      f.reset();
      renderAccount();
      toast(`Welcome, ${state.me.user.name}!`);
      if (afterAuth) afterAuth();
      else route();
    } catch (err) {
      $("auth-error").textContent = err.message;
    }
  };
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));

  function requireSignIn(then) {
    if (STATIC) { toast(SERVER_NEEDED, 7000); return false; }
    if (state.me?.user) return true;
    openAuth("signup", then);
    return false;
  }

  // -------------------------------------------------------------- pricing ---
  function renderPlans() {
    const box = $("plans");
    box.innerHTML = "";
    if (!state.config) return;
    const current = plan().id;
    for (const p of state.config.plans) {
      const isCurrent = state.me?.user && p.id === current;
      const card = h("div", { className: `plan${p.id === "pro" ? " featured" : ""}${isCurrent ? " current" : ""}` },
        h("h3", { textContent: p.name }),
        h("div", { className: "price" }, p.priceInr ? `₹${p.priceInr.toLocaleString("en-IN")}` : "₹0", h("small", { textContent: p.priceInr ? " / month" : " forever" })),
        h("div", { className: "muted", textContent: p.tagline }),
        h("ul", {}, p.features.map((f) => h("li", { textContent: f }))),
      );
      const btn = h("button", { className: `block ${p.priceInr && !isCurrent ? "primary" : ""}` });
      if (isCurrent) { btn.textContent = state.me.user.planExpires ? `Current plan · renews ${new Date(state.me.user.planExpires).toLocaleDateString()}` : "Current plan"; btn.disabled = !p.priceInr; if (p.priceInr) { btn.textContent = "Extend 30 days"; btn.disabled = false; btn.onclick = () => buy(p.id); } }
      else if (!p.priceInr) { btn.textContent = "Start free"; btn.onclick = () => (state.me?.user ? (location.hash = "#/studio") : openAuth("signup")); }
      else { btn.textContent = `Get ${p.name}`; btn.onclick = () => buy(p.id); }
      card.append(btn);
      box.append(card);
    }
    const b = state.config.billing;
    $("billing-note").textContent = b.razorpay
      ? "Paid plans give 30 days of access per payment. Secure checkout by Razorpay."
      : b.devBilling
        ? "Developer mode: Razorpay keys are not set, so plans activate instantly without payment."
        : "Payments are not configured on this server yet.";
  }

  let razorpayLoaded = null;
  function loadRazorpay() {
    razorpayLoaded ||= new Promise((resolve, reject) => {
      const s = h("script", { src: "https://checkout.razorpay.com/v1/checkout.js", onload: resolve, onerror: () => reject(new Error("Could not load Razorpay checkout")) });
      document.head.append(s);
    });
    return razorpayLoaded;
  }

  async function buy(planId) {
    if (!requireSignIn(() => buy(planId))) return;
    const billing = state.config.billing;
    try {
      if (!billing.razorpay && billing.devBilling) {
        state.me = await api("/api/billing/dev-activate", { method: "POST", body: { plan: planId } });
        renderAccount();
        renderPlans();
        toast(`${state.me.plan.name} activated (developer mode)`);
        return;
      }
      const order = await api("/api/billing/order", { method: "POST", body: { plan: planId } });
      await loadRazorpay();
      const rzp = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: "KernelCraft",
        description: `${order.planName} plan, 30 days`,
        prefill: order.prefill,
        theme: { color: "#1b8fd6" },
        handler: async (resp) => {
          try {
            state.me = await api("/api/billing/verify", { method: "POST", body: resp });
            renderAccount();
            renderPlans();
            toast(`Payment received. ${state.me.plan.name} is active!`);
          } catch (err) {
            toast(`Payment could not be verified: ${err.message}. If money was taken, it will be activated automatically or refunded.`, 8000);
          }
        },
      });
      rzp.on("payment.failed", (r) => toast(`Payment failed: ${r.error?.description || "unknown error"}`, 6000));
      rzp.open();
    } catch (err) {
      toast(err.message, 6000);
    }
  }

  // ------------------------------------------------------------- projects ---
  async function renderProjects() {
    const grid = $("project-grid");
    grid.innerHTML = "";
    if (STATIC) { grid.append(h("div", { className: "empty", textContent: SERVER_NEEDED })); return; }
    if (!state.me?.user) {
      grid.append(h("div", { className: "empty" }, "Sign in to see your saved operating systems. ", h("button", { className: "primary small", textContent: "Sign in", onclick: () => openAuth("login", renderProjects) })));
      return;
    }
    const { projects } = await api("/api/projects");
    if (!projects.length) {
      grid.append(h("div", { className: "empty" }, "No OSes yet. ", h("a", { href: "#/studio", textContent: "Build your first one" })));
      return;
    }
    const label = (id) => state.config.targets.find((t) => t.id === id)?.label || id;
    for (const p of projects) {
      const last = p.history[p.history.length - 1];
      const shot = last?.shots?.[last.shots.length - 1];
      grid.append(h("div", { className: "project-card" },
        h("div", { className: "thumb", style: shot ? `background-image:url(/api/projects/${p.id}/shots/${shot})` : "" }),
        h("div", { className: "body" },
          h("b", { textContent: p.name || "Untitled" }),
          h("span", { className: "muted", textContent: `${label(p.target)} · ${p.history.length} build${p.history.length === 1 ? "" : "s"}` }),
          h("span", { className: `badge ${p.verified ? "pass" : "fail"}`, textContent: p.verified ? "VERIFIED" : "UNVERIFIED", style: "align-self:flex-start" }),
        ),
        h("div", { className: "actions" },
          h("a", { className: "button primary small", href: `#/studio/${p.id}`, textContent: "Open" }),
          h("button", {
            className: "small", textContent: "Delete", onclick: async () => {
              if (!confirm(`Delete "${p.name}"? This cannot be undone.`)) return;
              await api(`/api/projects/${p.id}`, { method: "DELETE" });
              if (state.project?.id === p.id) newProject();
              renderProjects();
            },
          }),
        ),
      ));
    }
  }

  async function openProject(id) {
    try {
      const { project, files } = await api(`/api/projects/${id}`);
      state.project = project;
      state.target = project.target;
      setFiles(files || {});
      state.artifacts = project.artifacts || [];
      state.hardware = { ...defaultHardware(), ...(project.hardware || {}) };
      state.selectedApps.clear();
      renderProjectHead();
      renderTargets();
      renderHardware();
      renderApps();
      renderExportMenu();
      resetGallery();
      const last = project.history[project.history.length - 1];
      for (const [i, shot] of (last?.shots || []).entries()) {
        addPassCard({ pass: i + 1, stage: "boot", screenshot: `/api/projects/${id}/shots/${shot}`, verdict: { pass: last.verified && i === last.shots.length - 1, summary: last.request, issues: [] } });
      }
      log("system", `Opened "${project.name}" (${project.history.length} builds).`);
      await bootProjectArtifact(last?.shots?.length ? `/api/projects/${id}/shots/${last.shots[last.shots.length - 1]}` : null);
    } catch (err) {
      toast(err.message);
      location.hash = "#/studio";
    }
  }

  function newProject() {
    state.project = null;
    state.artifacts = [];
    state.hardware = defaultHardware();
    state.selectedApps.clear();
    setFiles({});
    renderProjectHead();
    renderHardware();
    renderExportMenu();
    resetGallery();
    if (location.hash.startsWith("#/studio/")) location.hash = "#/studio";
  }
  $("new-project").onclick = newProject;

  function renderProjectHead() {
    const p = state.project;
    $("project-mode").textContent = p ? "Change this OS" : "New OS";
    $("project-name").textContent = p ? p.name : "Untitled";
    $("prompt-label").textContent = p ? "What should change?" : "Describe your OS";
    $("prompt").placeholder = p ? "Add a paint app with a colour palette, and make the taskbar translucent" : "A 32-bit Windows-style OS called Nova with a taskbar, file explorer, notepad, a paint app and a neon blue theme";
    $("target-block").hidden = Boolean(p);
    $("build").textContent = p ? "Apply change with AI" : "Build OS";
    renderChips();
  }

  // -------------------------------------------------------------- targets ---
  function renderTargets() {
    const box = $("targets");
    if (!state.config) return;
    box.innerHTML = "";
    const allowed = plan().targets;
    for (const t of state.config.targets) {
      const locked = !allowed.includes(t.id);
      const planName = state.config.plans.find((p) => p.id === t.plan)?.name;
      const el = h("div", { className: `target${t.id === state.target ? " selected" : ""}${locked ? " locked" : ""}`, tabIndex: 0 },
        h("div", { className: "t-main" },
          h("b", { textContent: t.label }),
          h("small", { textContent: t.browserBootable ? "Runs in your browser" : "Verified in QEMU · export to run" }),
        ),
        locked ? h("span", { className: "lock", textContent: `🔒 ${planName}` }) : null,
      );
      el.onclick = () => {
        const wasLinux = state.target === "linux64";
        state.target = t.id;
        if (wasLinux !== (t.id === "linux64")) state.hardware = defaultHardware();
        renderTargets();
        renderChips();
        renderHardware();
        renderApps();
      };
      box.append(el);
    }
  }

  function renderChips() {
    const box = $("idea-chips");
    box.innerHTML = "";
    if (state.project) return;
    for (const idea of IDEAS[state.target] || []) box.append(h("span", { className: "chip", textContent: idea, onclick: () => ($("prompt").value = idea) }));
  }

  function renderUsage() {
    const u = state.me?.usage;
    $("usage").textContent = STATIC ? "AI builds need the KernelCraft server (see the banner above)." : !state.me?.user ? "Sign in to build. Free accounts can boot samples and upload images." :
      u.aiLimit ? `${Math.max(0, u.aiLimit - u.aiToday)} of ${u.aiLimit} AI builds left today · ${state.me.plan.name} plan` : "Your Free plan includes the emulator and samples. Upgrade to build with AI.";
  }

  // -------------------------------------------------------------- logging ---
  function log(agent, message) {
    const line = h("div", { className: "line" }, h("span", { className: `agent ${agent}`, textContent: `[${agent}]` }), message);
    $("log").append(line);
    $("log").scrollTop = $("log").scrollHeight;
  }
  $("clear-log").onclick = () => ($("log").textContent = "");

  // ------------------------------------------------------------- emulator ---
  let emulator = null;
  const serialBox = $("serial");
  function serialWrite(text) {
    serialBox.textContent += text;
    if (serialBox.textContent.length > 60000) serialBox.textContent = serialBox.textContent.slice(-40000);
    serialBox.scrollTop = serialBox.scrollHeight;
  }

  async function stopEmulator() {
    if (!emulator) return;
    const old = emulator;
    emulator = null;
    try { await old.destroy(); } catch (err) { console.warn(err); }
  }

  async function bootImage(bytes, label) {
    if (typeof V86 === "undefined") return toast("The emulator failed to load.");
    await stopEmulator();
    $("preview").hidden = true;
    $("screen_container").hidden = false;
    $("overlay").hidden = true;
    $("m-video").textContent = "–";
    serialWrite(`\n--- booting ${label} ---\n`);
    emulator = new V86({
      wasm_path: "vendor/v86.wasm",
      memory_size: browserRamMB() * 1024 * 1024,
      vga_memory_size: browserVramMB() * 1024 * 1024,
      screen: { container: $("screen_container"), use_graphical_text: true },
      bios: { url: "vendor/bios/seabios.bin" },
      vga_bios: { url: "vendor/bios/vgabios.bin" },
      fda: { buffer: bytes.slice().buffer },
      autostart: true,
    });
    emulator.add_listener("screen-set-size", ([w, hgt, bpp]) => ($("m-video").textContent = bpp ? `${w}×${hgt}×${bpp}` : `${w}×${hgt} text`));
    emulator.add_listener("serial0-output-byte", (b) => serialWrite(String.fromCharCode(b)));
    $("m-mem").textContent = `${mbText(browserRamMB())} + ${mbText(browserVramMB())} VGA`;
  }

  function showPreview(src, message) {
    stopEmulator();
    for (const m of ["m-video", "m-mem", "m-image"]) $(m).textContent = "–";
    $("screen_container").hidden = true;
    $("preview").src = src || "";
    $("preview").hidden = !src;
    const o = $("overlay");
    o.hidden = false;
    o.className = src ? "overlay caption" : "overlay";
    o.innerHTML = "";
    o.append(h("p", { className: "muted", textContent: message }));
  }

  function setImage(bytes, name, browserBootable) {
    state.image = { bytes, name, browserBootable };
    $("m-image").textContent = `${(bytes.length / 1024).toFixed(0)} KB`;
  }

  async function bootProjectArtifact(previewSrc) {
    const t = state.config.targets.find((x) => x.id === state.target);
    if (!state.project || !state.artifacts.length) return;
    if (t.browserBootable && state.artifacts.includes("floppy.img")) {
      const res = await fetch(`/api/projects/${state.project.id}/artifacts/floppy.img`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      setImage(bytes, `${slug(state.project.name)}.img`, true);
      bootImage(bytes, state.project.name);
    } else {
      showPreview(previewSrc, t.builder === "linux"
        ? "Screenshot from the verification VM. The browser emulator is 32-bit only; export the Linux build and run it with QEMU."
        : "Screenshot from the verification VM. The browser emulator is 32-bit only; export the image and run it with qemu-system-x86_64.");
    }
  }

  const slug = (s) => (s || "kernelcraft").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "kernelcraft";

  $("restart").onclick = () => state.image?.browserBootable && bootImage(state.image.bytes, state.image.name);
  $("cad").onclick = () => emulator?.keyboard_send_scancodes([0x1d, 0x38, 0x53, 0xd3, 0xb8, 0x9d]);
  $("lock-mouse").onclick = () => emulator ? emulator.lock_mouse() : toast("Boot an OS first");
  $("fullscreen").onclick = () => $("screen-frame").requestFullscreen?.();
  $("shot").onclick = () => {
    const img = emulator?.screen_make_screenshot();
    const src = img?.src || (!$("preview").hidden && $("preview").src);
    if (!src) return toast("Nothing to capture yet");
    h("a", { href: src, download: `${slug(state.project?.name)}-screenshot.png` }).click();
  };
  $("upload").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 32 * 1024 * 1024) return toast("Image too large (max 32 MB)");
    const bytes = new Uint8Array(await file.arrayBuffer());
    setImage(bytes, file.name, true);
    bootImage(bytes, file.name);
    log("system", `Booting uploaded image ${file.name}.`);
    e.target.value = "";
  };
  document.querySelectorAll("[data-sample]").forEach((b) => (b.onclick = () => bootSample(b.dataset.sample)));

  async function bootSample(target) {
    try {
      log("system", `Booting the ${target === "real16" ? "16-bit" : target === "showcase" ? "showcase (all apps, 1024×768)" : "32-bit desktop"} sample...`);
      // The showcase image is built for 1024x768 with 256 MB RAM and 16 MB VRAM.
      if (target === "showcase") { state.hardware = { ...defaultHardware(), ...(state.config.showcaseHardware || {}) }; renderHardware(); }
      const res = await fetch(STATIC ? `samples/${target}.img` : `/api/sample/${target}.img`);
      if (!res.ok) throw new Error("Could not build the sample");
      const bytes = new Uint8Array(await res.arrayBuffer());
      setImage(bytes, `kernelcraft-${target}-sample.img`, true);
      bootImage(bytes, "sample");
    } catch (err) {
      toast(err.message);
    }
  }

  // Metrics: instructions per second from v86, page FPS from rAF.
  let lastInstr = 0, frames = 0;
  (function frame() { frames++; requestAnimationFrame(frame); })();
  setInterval(() => {
    const running = emulator && emulator.is_running();
    $("m-cpu").textContent = !emulator ? "idle" : running ? "running" : "stopped";
    $("m-cpu").style.color = running ? "var(--pass)" : "";
    if (running) {
      const instr = emulator.get_instruction_counter();
      const delta = instr >= lastInstr ? instr - lastInstr : instr + 2 ** 32 - lastInstr;
      lastInstr = instr;
      $("m-mips").textContent = (delta / 1e6).toFixed(1);
      $("m-fps").textContent = frames;
    } else {
      $("m-mips").textContent = "–";
      $("m-fps").textContent = "–";
    }
    frames = 0;
  }, 1000);

  // --------------------------------------------------------------- export ---
  function renderExportMenu() {
    const menu = $("export-menu");
    menu.innerHTML = "";
    const items = [];
    if (state.project) for (const a of state.artifacts) items.push(h("a", { href: `/api/projects/${state.project.id}/artifacts/${a}`, textContent: `Download ${a}` }));
    else if (state.image) items.push(h("a", { href: "#", textContent: `Download ${state.image.name}`, onclick: (e) => { e.preventDefault(); downloadBytes(state.image.bytes, state.image.name); } }));
    if (Object.keys(state.files).length) items.push(h("a", { href: "#", textContent: "Download sources (.txt bundle)", onclick: (e) => { e.preventDefault(); downloadSources(); } }));
    menu.append(...items);
    $("export").disabled = !items.length;
  }
  $("export").onclick = (e) => { e.stopPropagation(); renderExportMenu(); $("export-menu").hidden = !$("export-menu").hidden; };
  document.addEventListener("click", () => ($("export-menu").hidden = true));

  function downloadBytes(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes]));
    h("a", { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadSources() {
    const text = Object.entries(state.files).map(([n, src]) => `===== ${n} =====\n${src}`).join("\n");
    downloadBytes(new TextEncoder().encode(text), `${slug(state.project?.name)}-sources.txt`);
  }

  // ----------------------------------------------------------- code editor ---
  function setFiles(files) {
    state.files = { ...files };
    state.savedFiles = { ...files };
    state.activeFile = Object.keys(files).find((n) => /kernel\.(c|asm)$|^rootfs\/init$/.test(n)) || Object.keys(files)[0] || null;
    renderFileList();
    showFile();
    renderApps();
  }

  function renderFileList() {
    const list = $("file-list");
    list.innerHTML = "";
    const names = Object.keys(state.files).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const dirty = state.files[name] !== state.savedFiles[name];
      list.append(h("button", {
        className: `file${name === state.activeFile ? " active" : ""}${dirty ? " dirty" : ""}`,
        textContent: name,
        title: name,
        onclick: () => { state.activeFile = name; renderFileList(); showFile(); },
      }));
    }
  }

  function showFile() {
    const ed = $("editor");
    $("editor-name").textContent = state.activeFile || "No file";
    ed.value = state.activeFile ? state.files[state.activeFile] : "";
    ed.disabled = !state.activeFile;
  }

  $("editor").addEventListener("input", (e) => {
    if (!state.activeFile) return;
    state.files[state.activeFile] = e.target.value;
    renderFileList();
  });
  $("editor").addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const ed = e.target;
    ed.setRangeText("    ", ed.selectionStart, ed.selectionEnd, "end");
    ed.dispatchEvent(new Event("input"));
  });
  $("revert").onclick = () => {
    if (!state.activeFile) return;
    state.files[state.activeFile] = state.savedFiles[state.activeFile] ?? "";
    renderFileList();
    showFile();
  };
  $("new-file").onclick = () => {
    const name = prompt(state.target === "linux64" ? "New file path (rootfs/... or src/name.c)" : "New file name (e.g. app_paint.c)");
    if (!name) return;
    if (state.files[name] == null) state.files[name] = "";
    state.activeFile = name;
    renderFileList();
    showFile();
  };
  $("rebuild").onclick = async () => {
    if (!Object.keys(state.files).length) return toast("Nothing to build yet");
    if (!requireSignIn()) return;
    await runBuild("/api/rebuild", { target: state.target, files: state.files, projectId: state.project?.id, hardware: hw() });
  };

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      for (const name of ["display", "code", "apps", "serial"]) $(`tab-${name}`).hidden = tab.dataset.tab !== name;
    };
  });

  // -------------------------------------------------------------- gallery ---
  function resetGallery() {
    $("gallery").innerHTML = "";
    $("pass-summary").textContent = "";
  }

  function addPassCard(ev) {
    const ok = ev.verdict?.pass;
    const thumb = h("div", { className: "thumb" });
    if (ev.screenshot) thumb.style.backgroundImage = `url(${ev.screenshot})`;
    else thumb.textContent = ev.stage === "build" ? "build error" : "no screenshot";
    const card = h("div", { className: `card ${ok ? "pass" : "fail"}` },
      h("header", {}, h("span", { textContent: `Pass ${ev.pass} · ${ev.stage === "build" ? "build" : "boot"}` }), h("span", { className: `badge ${ok ? "pass" : "fail"}`, textContent: ok ? "PASS" : "FAIL" })),
      thumb,
      h("p", { textContent: ev.verdict?.summary || "" }),
    );
    card.onclick = () => openLightbox(ev);
    $("gallery").append(card);
    $("gallery").scrollLeft = $("gallery").scrollWidth;
  }

  function openLightbox(ev) {
    $("lightbox-img").hidden = !ev.screenshot;
    $("lightbox-img").src = ev.screenshot || "";
    const box = $("lightbox-text");
    box.innerHTML = "";
    box.append(h("h3", { textContent: `Pass ${ev.pass}: ${ev.verdict?.pass ? "PASS" : "FAIL"} — ${ev.verdict?.summary || ""}` }));
    if (ev.verdict?.issues?.length) box.append(h("ul", {}, ev.verdict.issues.map((i) => h("li", {}, h("pre", { textContent: i, style: "white-space:pre-wrap" })))));
    $("lightbox").showModal();
  }

  // ---------------------------------------------------------------- build ---
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

  function setBusy(busy) {
    state.building = busy;
    $("build").disabled = busy;
    $("rebuild").disabled = busy;
    $("build").textContent = busy ? "Working…" : state.project ? "Apply change with AI" : "Build OS";
    $("hw-apply").disabled = $("custom-app-btn").disabled = busy;
    renderApps();
  }

  $("build").onclick = async () => {
    const text = $("prompt").value.trim();
    if (!text) return toast(state.project ? "Describe the change first" : "Describe your OS first");
    if (!requireSignIn()) return;
    if (!state.project && !plan().targets.includes(state.target)) {
      const needed = state.config.targets.find((t) => t.id === state.target).plan;
      toast(`This target needs the ${state.config.plans.find((p) => p.id === needed).name} plan`);
      location.hash = "#/pricing";
      return;
    }
    const body = state.project
      ? { projectId: state.project.id, change: text, hardware: hw() }
      : { prompt: text, target: state.target, hardware: hw(), apps: isSdkTarget() ? [...state.selectedApps] : [] };
    await runBuild("/api/build-os", body);
  };

  async function runBuild(url, body) {
    if (state.building) return;
    setBusy(true);
    resetGallery();
    const screenshots = {};
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!(res.headers.get("content-type") || "").includes("ndjson")) {
        const err = await res.json().catch(() => ({}));
        if (err.upgrade) { toast(`${err.error}. Opening plans…`); location.hash = "#/pricing"; }
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      for await (const ev of ndjson(res)) {
        if (ev.type === "log") log(ev.agent, ev.message);
        else if (ev.type === "pass") { screenshots[ev.pass] = ev.screenshot; addPassCard(ev); }
        else if (ev.type === "error") log("error", ev.message);
        else if (ev.type === "result") await handleResult(ev, screenshots);
      }
    } catch (err) {
      log("error", err.message);
      toast(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleResult(result, screenshots) {
    const n = result.passes.length;
    $("pass-summary").textContent = result.verified ? `verified on pass ${result.finalPass} of ${n}` : `not verified after ${n} pass${n === 1 ? "" : "es"}`;
    if (result.account) { state.me = result.account; renderAccount(); }
    if (result.files) setFiles(result.files);
    if (!result.projectId) { log("error", "No bootable build was produced."); return; }
    const first = !state.project || state.project.id !== result.projectId;
    const { project } = await api(`/api/projects/${result.projectId}`);
    state.project = project;
    state.target = project.target;
    state.artifacts = project.artifacts || [];
    if (project.hardware) state.hardware = { ...project.hardware };
    state.selectedApps.clear();
    renderProjectHead();
    renderExportMenu();
    renderHardware();
    renderApps();
    if (first) history.replaceState(null, "", `#/studio/${project.id}`);
    $("prompt").value = "";
    if (result.serialLog) serialWrite(`\n--- verification VM serial log ---\n${result.serialLog}\n`);
    await bootProjectArtifact(screenshots[result.finalPass]);
    toast(result.verified ? "Your OS is ready!" : "Built, but the vision check found problems. See the passes below.");
  }

  // ------------------------------------------------------------- hardware ---
  const HW_FIELDS = ["cpus", "cpuModel", "ramMB", "vramMB", "resolution"];
  const isSdkTarget = () => state.target === "prot32" || state.target === "long64";
  function defaultHardware() {
    const o = state.config?.hardware;
    if (!o) return { resolution: "800x600", ramMB: 64, vramMB: 16, cpus: 1, cpuModel: "basic" };
    return { ...(state.target === "linux64" ? o.linuxDefaults : o.defaults) };
  }
  const hw = () => state.hardware || defaultHardware();
  // v86 runs inside the browser tab, so its RAM is capped to keep tabs healthy.
  const browserRamMB = () => Math.min(hw().ramMB || 64, 1024);
  const browserVramMB = () => Math.min(hw().vramMB || 16, 128);
  const mbText = (v) => (v >= 1024 ? `${v / 1024} GB` : `${v} MB`);
  const sameHardware = (a, b) => HW_FIELDS.every((f) => String(a?.[f]) === String(b?.[f]));

  function hwText(x) {
    const model = x.cpuModel === "modern" ? "modern" : "basic";
    return state.target === "real16"
      ? `${x.cpus} core · ${mbText(x.ramMB)} RAM`
      : `${x.cpus} core${x.cpus > 1 ? "s" : ""} ${model} · ${mbText(x.ramMB)} · ${x.resolution.replace("x", "×")} · ${mbText(x.vramMB)} VRAM`;
  }

  function renderHardware() {
    const o = state.config?.hardware;
    if (!o) return;
    const x = hw();
    const linux = state.target === "linux64";
    const fill = (id, values, label = (v) => v) => {
      const sel = $(`hw-${id}`);
      sel.innerHTML = "";
      for (const v of values) sel.append(h("option", { value: v, textContent: label(v) }));
      sel.value = x[id];
    };
    fill("cpus", o.cpus, (v) => `${v} core${v > 1 ? "s" : ""}`);
    fill("cpuModel", Object.keys(o.cpuModels), (v) => o.cpuModels[v]);
    fill("ramMB", o.ramMB, (v) => (v >= 1024 ? `${v / 1024} GB` : `${v} MB`));
    fill("vramMB", o.vramMB, mbText);
    fill("resolution", linux ? o.linuxResolutions : o.resolutions, (v) => v.replace("x", " × "));
    $("hw-resolution").disabled = $("hw-vramMB").disabled = state.target === "real16";
    $("hw-summary").textContent = hwText(x);
    const notes = [];
    const [w, hgt] = x.resolution.split("x").map(Number);
    if (state.target === "real16") notes.push("16-bit OSes choose their own BIOS video mode, so resolution and graphics memory don't apply.");
    else if (w * hgt * 4 > x.vramMB * 1048576) notes.push(`${x.resolution} needs more graphics memory; it will be raised automatically.`);
    if (x.cpus > 1 && !linux) notes.push("Extra cores show up in the OS; the SDK schedules on the first core (ask the AI to add SMP).");
    const lim = o.limits;
    if (x.ramMB > lim.vmRamMB) notes.push(`The test VM gets ${mbText(lim.vmRamMB)}; the exported run-qemu.sh uses the full ${mbText(x.ramMB)}.`);
    if (!linux && x.ramMB > lim.sdkRamMB) notes.push(`SDK kernels use up to ${mbText(lim.sdkRamMB)} of RAM (Linux Forge uses all of it).`);
    if (x.vramMB > lim.vgaVramMB) notes.push(`The emulated graphics card holds up to ${mbText(lim.vgaVramMB)}.`);
    if (!linux && state.target !== "long64" && (x.ramMB > 1024 || x.vramMB > 128)) notes.push("In this browser tab the emulator runs with up to 1 GB RAM and 128 MB graphics memory.");
    $("hw-note").textContent = notes.join(" ");
    const changed = state.project && !sameHardware(x, { ...defaultHardware(), ...(state.project.hardware || {}) });
    $("hw-apply").hidden = !changed;
  }

  for (const f of HW_FIELDS) {
    $(`hw-${f}`).onchange = (e) => {
      const v = e.target.value;
      state.hardware = { ...hw(), [f]: f === "cpuModel" || f === "resolution" ? v : Number(v) };
      renderHardware();
    };
  }
  $("hw-apply").onclick = async () => {
    if (!requireSignIn()) return;
    await runBuild("/api/rebuild", { target: state.target, files: state.files, projectId: state.project.id, hardware: hw() });
  };

  // ----------------------------------------------------------------- apps ---
  const appFile = (id) => `app_${id}.c`;
  const installed = (id) => state.files[appFile(id)] != null;

  function renderApps() {
    const grid = $("app-grid");
    if (!grid || !state.config) return;
    grid.innerHTML = "";
    const sdk = isSdkTarget();
    const count = state.project ? state.config.apps.filter((a) => installed(a.id)).length : state.selectedApps.size;
    $("apps-count").textContent = sdk && count ? String(count) : "";
    $("apps-hint").textContent = !sdk
      ? "Ready-made apps are for 32-bit and 64-bit desktops. Use “Make any app with AI” for this target."
      : state.project ? "Adding or removing an app rebuilds your OS without using an AI build." : "Pick apps now and they're included in your first build.";
    $("custom-app").placeholder = state.target === "linux64" ? "A terminal to-do list app that saves to /home" : "A to-do list app with checkboxes and due dates";
    for (const a of state.config.apps) {
      const on = state.project ? installed(a.id) : state.selectedApps.has(a.id);
      const btn = h("button", { className: `small ${on ? "added" : "primary"}`, textContent: on ? (state.project ? "Installed · Remove" : "✓ Added") : "Add", disabled: !sdk || state.building });
      btn.onclick = () => toggleApp(a, on);
      grid.append(h("div", { className: `app-card${on ? " added" : ""}` },
        h("div", { className: "app-top" },
          h("div", { className: "app-icon", textContent: a.emoji }),
          h("div", {}, h("b", { textContent: a.name }), h("div", { className: "app-cat", textContent: a.category })),
        ),
        h("p", { textContent: a.description }),
        btn,
      ));
    }
  }

  async function toggleApp(app, on) {
    if (!state.project) {
      if (on) state.selectedApps.delete(app.id); else state.selectedApps.add(app.id);
      renderApps();
      return;
    }
    if (!requireSignIn()) return;
    const files = { ...state.files };
    if (on) delete files[appFile(app.id)];
    else Object.assign(files, (await api(`/api/apps/${app.id}`)).files);
    log("system", `${on ? "Removing" : "Installing"} ${app.name} and rebuilding…`);
    state.files = files;
    renderFileList();
    await runBuild("/api/rebuild", { target: state.target, files, projectId: state.project.id, hardware: hw() });
  }

  $("custom-app-btn").onclick = async () => {
    const idea = $("custom-app").value.trim();
    if (!idea) return toast("Describe the app first");
    if (state.project) {
      if (!requireSignIn()) return;
      await runBuild("/api/build-os", { projectId: state.project.id, change: `Add a new app to this OS: ${idea}. Give it its own icon and window${state.target === "linux64" ? " (a program in src/ that the launcher can start)" : " (KC_APP)"}.`, hardware: hw() });
      $("custom-app").value = "";
    } else {
      const p = $("prompt");
      p.value = `${p.value.trim()}${p.value.trim() ? " " : ""}Include an app: ${idea}.`;
      $("custom-app").value = "";
      toast("Added to your OS description. Press Build OS when ready.");
    }
  };

  // ----------------------------------------------------------------- docs ---
  $("show-kch").onclick = async (e) => {
    e.preventDefault();
    const pre = $("kch");
    if (!pre.textContent) pre.textContent = (await api("/api/sdk")).files["kc.h"];
    pre.hidden = !pre.hidden;
  };

  // ----------------------------------------------------------------- init ---
  (async () => {
    if (STATIC) document.body.classList.add("static");
    state.config = await api("/api/config");
    if (STATIC) {
      $("static-banner").hidden = false;
      $("codespaces-link").href = state.config.codespaces || state.config.repo || "#";
    }
    document.querySelectorAll('[data-sample="showcase"]').forEach((b) => (b.hidden = false));
    state.hardware = defaultHardware();
    await refreshMe();
    renderHardware();
    renderApps();
    renderProjectHead();
    route();
  })();
})();
