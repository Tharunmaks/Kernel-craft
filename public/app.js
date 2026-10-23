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
  };

  const IDEAS = {
    real16: ["A DOS-style shell with a file list and a snake game", "A retro BIOS setup screen with menus", "A hacker terminal with a matrix rain intro"],
    prot32: ["A Windows-95-style desktop with a start menu, file explorer and paint app", "A macOS-like dock with a clock widget and notes", "A neon cyberpunk OS with a music visualiser and a snake game"],
    long64: ["A 64-bit workstation OS with a system monitor, process list and a text editor", "A kiosk OS with a big touch-style app launcher"],
    linux64: ["A Linux distro for students with a menu-driven study timer and notes app", "A retro gaming Linux that boots into a launcher of terminal games", "A server dashboard distro that shows live CPU and memory graphs"],
  };

  // ------------------------------------------------------------------ api ---
  async function api(path, { method = "GET", body } = {}) {
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
    if (!state.me?.user) {
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
      renderProjectHead();
      renderTargets();
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
    setFiles({});
    renderProjectHead();
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
        state.target = t.id;
        renderTargets();
        renderChips();
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
    $("usage").textContent = !state.me?.user ? "Sign in to build. Free accounts can boot samples and upload images." :
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
      wasm_path: "/vendor/v86.wasm",
      memory_size: 64 * 1024 * 1024,
      vga_memory_size: 8 * 1024 * 1024,
      screen: { container: $("screen_container"), use_graphical_text: true },
      bios: { url: "/vendor/bios/seabios.bin" },
      vga_bios: { url: "/vendor/bios/vgabios.bin" },
      fda: { buffer: bytes.slice().buffer },
      autostart: true,
    });
    emulator.add_listener("screen-set-size", ([w, hgt, bpp]) => ($("m-video").textContent = bpp ? `${w}×${hgt}×${bpp}` : `${w}×${hgt} text`));
    emulator.add_listener("serial0-output-byte", (b) => serialWrite(String.fromCharCode(b)));
    $("m-mem").textContent = "64 MB + 8 MB VGA";
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
      log("system", `Booting the ${target === "real16" ? "16-bit" : "32-bit desktop"} sample...`);
      const res = await fetch(`/api/sample/${target}.img`);
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
    await runBuild("/api/rebuild", { target: state.target, files: state.files, projectId: state.project?.id });
  };

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      for (const name of ["display", "code", "serial"]) $(`tab-${name}`).hidden = tab.dataset.tab !== name;
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
    const body = state.project ? { projectId: state.project.id, change: text } : { prompt: text, target: state.target };
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
    renderProjectHead();
    renderExportMenu();
    if (first) history.replaceState(null, "", `#/studio/${project.id}`);
    $("prompt").value = "";
    if (result.serialLog) serialWrite(`\n--- verification VM serial log ---\n${result.serialLog}\n`);
    await bootProjectArtifact(screenshots[result.finalPass]);
    toast(result.verified ? "Your OS is ready!" : "Built, but the vision check found problems. See the passes below.");
  }

  // ----------------------------------------------------------------- docs ---
  $("show-kch").onclick = async (e) => {
    e.preventDefault();
    const pre = $("kch");
    if (!pre.textContent) pre.textContent = (await api("/api/sdk")).files["kc.h"];
    pre.hidden = !pre.hidden;
  };

  // ----------------------------------------------------------------- init ---
  (async () => {
    state.config = await api("/api/config");
    await refreshMe();
    renderProjectHead();
    route();
  })();
})();
