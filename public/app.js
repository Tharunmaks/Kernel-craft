// KernelCraft web app: a chat-first OS builder. You describe an OS, the AI
// builds it and it boots in the v86 emulator; every follow-up message changes
// it. Also: accounts, pricing + Razorpay, saved projects, code editor.
(() => {
  const $ = (id) => document.getElementById(id);
  const h = (tag, props = {}, ...children) => {
    const el = Object.assign(document.createElement(tag), props);
    for (const c of children.flat()) if (c != null) el.append(c);
    return el;
  };
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  const state = {
    config: null,
    me: null,                 // { user, plan, usage } or { user: null }
    targetChoice: "auto",     // "auto" or a target id, for new OSes
    target: "prot32",         // target of the open project (or last build)
    project: null,            // saved project meta
    files: {},                // current sources (editable)
    savedFiles: {},           // last built sources
    activeFile: null,
    image: null,              // { bytes, name, browserBootable }
    artifacts: [],            // names of downloadable artifacts for the project
    building: false,
    hardware: null,           // { resolution, ramMB, vramMB, cpus, cpuModel }
    selectedApps: new Set(),  // ready-made apps picked before the first build
  };

  const IDEAS = [
    "A Windows 95 style desktop with a start menu, notepad and paint",
    "A neon cyberpunk OS with a music visualiser and a snake game",
    "A macOS-like desktop with a dock, clock widget and notes app",
    "A retro DOS shell with a file list and a hacker matrix intro",
    "A Linux distro for students with a study timer and notes",
  ];
  const NEXT_IDEAS = {
    sdk: ["Add a calculator app", "Make the theme dark purple", "Add a snake game", "Show a boot animation with my OS name", "Add a file explorer"],
    real16: ["Add a snake game", "Make the text green on black", "Add a help command", "Show an ASCII logo at boot"],
    linux64: ["Add a menu launcher at login", "Add a to-do list program", "Show a custom welcome banner", "Add a system info command"],
  };

  // The GitHub Pages build sets window.KC_STATIC. It has no server of its
  // own, so it builds through a KernelCraft server the user connects
  // (Codespaces, or their own), using a bearer token instead of a cookie.
  const STATIC = Boolean(window.KC_STATIC);
  let server = STATIC ? storage.get("kc_server") || "" : "";
  const remote = () => STATIC && Boolean(server);
  const offline = () => STATIC && !server;
  const tokenKey = () => `kc_token:${server}`;

  // ------------------------------------------------------------------ api ---
  const apiUrl = (path) => (remote() ? server : "") + path;
  function authHeaders() {
    const t = remote() && storage.get(tokenKey());
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  async function staticApi(path) {
    if (path === "/api/config") return (await fetch("static.json")).json();
    if (path === "/api/me") return { user: null };
    if (path === "/api/sdk") return { files: { "kc.h": await (await fetch("sdk/kc.h")).text() } };
    throw new Error("Connect a KernelCraft server first (⚙ next to the send button).");
  }

  async function api(path, { method = "GET", body } = {}) {
    if (offline()) return staticApi(path);
    const res = await fetch(apiUrl(path), {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
    if (data.token) { storage.set(tokenKey(), data.token); delete data.token; }
    return data;
  }

  // Project files (screenshots, images) need auth, so a remote server's are
  // fetched with the token and shown through blob URLs.
  async function fetchFile(path) {
    const res = await fetch(apiUrl(path), { headers: authHeaders() });
    if (!res.ok) throw new Error(`Could not load ${path.split("/").pop()}`);
    return res;
  }
  async function fileUrl(path) {
    if (!remote()) return path;
    return URL.createObjectURL(await (await fetchFile(path)).blob());
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
    if (name === "studio" && !$("chat").childElementCount) welcome();
    if (name === "studio") setTimeout(() => $("prompt").focus(), 0);
    if (name === "home") setTimeout(() => $("hero-prompt").focus(), 0);
  }
  window.addEventListener("hashchange", route);

  // -------------------------------------------------------------- account ---
  function plan() { return state.me?.plan || { id: "free", targets: [] }; }

  function renderAccount() {
    const box = $("account");
    box.innerHTML = "";
    if (offline()) {
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
    await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
    if (remote()) storage.set(tokenKey(), null);
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
    $("auth-title").textContent = signup ? "Create your free account" : "Sign in";
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
      const then = afterAuth;
      afterAuth = null;
      if (then) then();
      else route();
    } catch (err) {
      $("auth-error").textContent = err.message;
    }
  };
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));

  function requireSignIn(then) {
    if (offline()) { needServer(); return false; }
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
    if (offline()) {
      grid.append(h("div", { className: "empty" }, "Your saved OSes live on your KernelCraft server. ", h("a", { href: "#/studio", textContent: "Connect one in the builder" }), "."));
      return;
    }
    if (!state.me?.user) {
      grid.append(h("div", { className: "empty" }, "Sign in to see your saved operating systems. ", h("button", { className: "primary small", textContent: "Sign in", onclick: () => openAuth("login", renderProjects) })));
      return;
    }
    const { projects } = await api("/api/projects");
    if (!projects.length) {
      grid.append(h("div", { className: "empty" }, "No OSes yet. ", h("a", { href: "#/", textContent: "Describe your first one" })));
      return;
    }
    for (const p of projects) {
      const last = p.history[p.history.length - 1];
      const shot = last?.shots?.[last.shots.length - 1];
      const thumb = h("div", { className: "thumb" });
      if (shot) fileUrl(`/api/projects/${p.id}/shots/${shot}`).then((u) => (thumb.style.backgroundImage = `url(${u})`)).catch(() => {});
      grid.append(h("div", { className: "project-card" },
        thumb,
        h("div", { className: "body" },
          h("b", { textContent: p.name || "Untitled" }),
          h("span", { className: "muted", textContent: `${targetLabel(p.target)} · ${p.history.length} version${p.history.length === 1 ? "" : "s"}` }),
          h("span", { className: `badge ${p.verified ? "pass" : "fail"}`, textContent: p.verified ? "WORKING" : "NEEDS FIXES", style: "align-self:flex-start" }),
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
      // Replay the project's history as a conversation.
      clearChat();
      project.history.forEach((entry, i) => {
        const manual = entry.request === "Manual edit";
        userMsg(manual ? "▶ Run my code edits" : entry.request);
        const last = i === project.history.length - 1;
        const bubble = aiMsg(h("p", { className: entry.verified ? "result-ok" : "result-warn", textContent: entry.verified ? "✓ Built and working." : "⚠ Built, but the screen check found problems." }));
        if (last && entry.shots?.length) {
          const shots = h("div", { className: "shots" });
          const name = entry.shots[entry.shots.length - 1];
          const el = h("div", { className: `shot ${entry.verified ? "pass" : "fail"}`, title: "Click to enlarge" });
          fileUrl(`/api/projects/${id}/shots/${name}`).then((u) => { el.style.backgroundImage = `url(${u})`; el.onclick = () => openLightbox({ pass: entry.passes, screenshot: u, verdict: { pass: entry.verified, summary: entry.request, issues: [] } }); }).catch(() => {});
          shots.append(el);
          bubble.append(shots);
        }
        if (last) bubble.append(nextIdeas());
      });
      const last = project.history[project.history.length - 1];
      const shot = last?.shots?.length ? await fileUrl(`/api/projects/${id}/shots/${last.shots[last.shots.length - 1]}`).catch(() => null) : null;
      await bootProjectArtifact(shot);
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
    renderTargets();
    renderHardware();
    renderExportMenu();
    clearChat();
    welcome();
    showEmpty();
    if (location.hash.startsWith("#/studio/")) history.replaceState(null, "", "#/studio");
  }
  $("new-project").onclick = newProject;

  function renderProjectHead() {
    const p = state.project;
    $("project-name").textContent = p ? p.name : "New OS";
    $("project-sub").textContent = p ? `${targetLabel(p.target)} · ${hwText(hw())}` : "Describe it and the AI builds it";
    $("prompt").placeholder = p ? "Ask for a change… e.g. “add a calculator and make it dark”" : "Describe the OS you want…";
    $("target-block").hidden = Boolean(p);
    renderSettingsSummary();
  }

  // -------------------------------------------------------------- targets ---
  const targetLabel = (id) => state.config?.targets.find((t) => t.id === id)?.label || id;
  const SHORT = { real16: "16-bit", prot32: "32-bit desktop", long64: "64-bit", linux64: "Linux" };

  // "Auto" picks the OS type from the words in the request, within the plan.
  function autoTarget(text) {
    const allowed = plan().targets;
    const want = /\blinux|distro|busybox/i.test(text) ? "linux64"
      : /64.?bit|long mode|x86.?64/i.test(text) ? "long64"
      : /16.?bit|real mode|\bdos\b|boot ?sector|\bbios\b/i.test(text) ? "real16"
      : "prot32";
    if (allowed.includes(want)) return { target: want };
    const fallback = ["prot32", "real16", "long64", "linux64"].find((t) => allowed.includes(t));
    return fallback ? { target: fallback, note: `${SHORT[want]} OSes need the ${planNameFor(want)} plan, so I'll build a ${SHORT[fallback]} OS instead.` } : { target: want };
  }
  const planNameFor = (target) => state.config.plans.find((p) => p.id === state.config.targets.find((t) => t.id === target)?.plan)?.name;

  function renderTargets() {
    const box = $("targets");
    if (!state.config) return;
    box.innerHTML = "";
    const allowed = plan().targets;
    const options = [{ id: "auto", label: "Auto", hint: "The AI picks from your words" }, ...state.config.targets];
    for (const t of options) {
      const locked = t.id !== "auto" && !allowed.includes(t.id);
      const el = h("div", { className: `target${t.id === state.targetChoice ? " selected" : ""}${locked ? " locked" : ""}`, tabIndex: 0 },
        h("div", { className: "t-main" },
          h("b", { textContent: t.label }),
          h("small", { textContent: t.hint || (t.browserBootable ? "Runs in your browser" : "Tested in a VM · download to run") }),
        ),
        locked ? h("span", { className: "lock", textContent: `🔒 ${planNameFor(t.id)}` }) : null,
      );
      el.onclick = () => {
        state.targetChoice = t.id;
        const next = t.id === "auto" ? "prot32" : t.id;
        if ((state.target === "linux64") !== (next === "linux64")) state.hardware = null;
        state.target = next;
        state.hardware = state.hardware || defaultHardware();
        renderTargets();
        renderHardware();
        renderApps();
        renderSettingsSummary();
      };
      box.append(el);
    }
  }

  function renderSettingsSummary() {
    const type = state.project ? SHORT[state.project.target] : state.targetChoice === "auto" ? "Auto" : SHORT[state.targetChoice];
    $("settings-summary").textContent = `${type} · ${mbText(hw().ramMB)} RAM`;
  }

  function renderUsage() {
    const u = state.me?.usage;
    $("usage").textContent = offline() || !state.me?.user ? "" : u.aiLimit ? `${Math.max(0, u.aiLimit - u.aiToday)} builds left today` : "Free plan";
  }

  // ----------------------------------------------------------------- chat ---
  const chat = $("chat");
  function scrollChat() { chat.scrollTop = chat.scrollHeight; }
  function clearChat() { chat.innerHTML = ""; }

  function userMsg(text) {
    chat.append(h("div", { className: "msg user" }, h("div", { className: "bubble", textContent: text })));
    scrollChat();
  }

  function aiMsg(...content) {
    const bubble = h("div", { className: "bubble" }, ...content);
    chat.append(h("div", { className: "msg ai" }, h("div", { className: "avatar", textContent: "▣" }), bubble));
    scrollChat();
    return bubble;
  }

  const p = (text) => h("p", { textContent: text });
  const chipRow = (ideas, onPick = (idea) => send(idea)) => h("div", { className: "chips" }, ideas.map((idea) => h("span", { className: "chip", textContent: idea, onclick: () => onPick(idea) })));
  const nextIdeas = () => chipRow(NEXT_IDEAS[state.target === "real16" || state.target === "linux64" ? state.target : "sdk"]);

  function welcome() {
    aiMsg(
      h("p", {}, h("b", { textContent: "Hi! What OS should we build?" })),
      p("Describe it in your own words: the look, the apps, games, a name. I'll write it, test it and boot it on the right. Then just keep chatting to change it."),
      Object.assign(chipRow(IDEAS), { id: "welcome-ideas" }),
    );
    if (offline()) needServer(true);
  }

  function needServer(quiet = false) {
    const box = aiMsg(
      h("p", {}, h("b", { textContent: "One step before I can build" })),
      p("This page runs on GitHub Pages, which can't compile or test operating systems. Start your own KernelCraft server in GitHub Codespaces (free, one click), make port 8086 Public in the Ports tab, and paste its address in ⚙ Settings."),
      h("div", { className: "actions-row" },
        h("a", { className: "button small primary", href: state.config?.codespaces || "#", target: "_blank", rel: "noopener", textContent: "Start a server in Codespaces" }),
        h("button", { className: "small", textContent: "I have a server address", onclick: (e) => { e.stopPropagation(); openSettings(); $("server-url").focus(); } }),
        h("button", { className: "small", textContent: "Meanwhile, try a demo OS", onclick: () => bootSample("showcase") }),
      ),
    );
    box.classList.add("need-server");
    if (!quiet) box.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  // Turns pipeline events into a friendly live progress message.
  const STEPS = [
    { id: "write", label: "Writing the code", agents: ["generator", "architect", "writer", "fixer"] },
    { id: "compile", label: "Compiling", agents: ["builder"] },
    { id: "boot", label: "Booting it in a test machine", agents: ["runner"] },
    { id: "check", label: "Checking the screen", agents: ["critic"] },
  ];
  const STATUS = {
    architect: "Planning the design…", writer: "Writing code…", generator: "Writing code…", fixer: "Fixing a problem…",
    builder: "Compiling…", runner: "Booting your OS in a test machine…", critic: "Looking at the screen…",
  };

  function progressBubble(intro) {
    const items = STEPS.map((s) => h("li", {}, h("span", { className: "st", textContent: "○" }), s.label));
    const status = h("div", { className: "status-line" }, h("span", { className: "typing" }, h("i"), h("i"), h("i")), h("span", { textContent: "Getting ready…" }));
    const shots = h("div", { className: "shots" });
    const log = h("div", { className: "log" });
    const details = h("details", { className: "log-details" }, h("summary", { textContent: "Show what the AI is doing" }), log);
    const bubble = aiMsg(p(intro), h("ul", { className: "steps-list" }, items), status, shots, details);
    let current = -1;
    let attempt = 1;
    const setStep = (i) => {
      items.forEach((li, j) => {
        li.className = j < i ? "done" : j === i ? "active" : "";
        li.firstChild.textContent = j < i ? "✓" : j === i ? "◌" : "○";
      });
      current = i;
    };
    const setStatus = (text) => (status.lastChild.textContent = text);
    return {
      bubble,
      log(agent, message) {
        log.append(h("div", { className: "line" }, h("span", { className: `agent ${agent}`, textContent: `[${agent}]` }), message));
        log.scrollTop = log.scrollHeight;
        const i = STEPS.findIndex((s) => s.agents.includes(agent));
        if (i >= 0) {
          if (i < current) { attempt++; }
          setStep(i);
          setStatus(attempt > 1 && i === 0 ? `Fixing what went wrong (attempt ${attempt})…` : STATUS[agent]);
        } else if (agent === "error") setStatus(message);
        scrollChat();
      },
      pass(ev, url) {
        const ok = ev.verdict?.pass;
        const el = h("div", { className: `shot ${ok ? "pass" : "fail"}`, title: ev.verdict?.summary || "" }, h("span", { textContent: `#${ev.pass}` }));
        if (url) el.style.backgroundImage = `url(${url})`;
        el.onclick = () => openLightbox({ ...ev, screenshot: url });
        shots.append(el);
        if (!ok && current >= 0) items[current].className = "failed";
        setStatus(ok ? "Looks good!" : `Found a problem: ${ev.verdict?.summary || "fixing it"}`);
        scrollChat();
      },
      finish(ok, text, extra = []) {
        status.remove();
        if (ok) setStep(STEPS.length);
        bubble.insertBefore(h("p", { className: ok ? "result-ok" : "result-warn", textContent: text }), shots);
        bubble.append(...extra);
        scrollChat();
      },
      fail(text) {
        status.remove();
        bubble.insertBefore(h("p", { className: "result-warn", textContent: text }), shots);
        scrollChat();
      },
    };
  }

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
    showTab("display");
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

  function overlay(icon, title, text, className = "overlay") {
    const o = $("overlay");
    o.hidden = false;
    o.className = className;
    o.innerHTML = "";
    o.append(h("div", { className: "empty-screen" }, icon ? h("div", { className: "empty-icon", textContent: icon }) : null, title ? h("h3", { textContent: title }) : null, h("p", { className: "muted", textContent: text })));
  }

  function showEmpty() {
    stopEmulator();
    $("screen_container").hidden = true;
    $("preview").hidden = true;
    overlay("▣", "Your OS will appear here", "Tell the AI what to build in the chat. It boots here as soon as it's ready.");
  }

  function showBuilding() {
    if (emulator) return; // keep the current OS running while the next version builds
    $("preview").hidden = true;
    overlay("▣", "Building your OS…", "Follow along in the chat. This usually takes under a minute.", "overlay building");
  }

  function showPreview(src, message) {
    stopEmulator();
    for (const m of ["m-video", "m-mem", "m-image"]) $(m).textContent = "–";
    $("screen_container").hidden = true;
    $("preview").src = src || "";
    $("preview").hidden = !src;
    overlay(null, null, message, src ? "overlay caption" : "overlay");
  }

  function setImage(bytes, name, browserBootable) {
    state.image = { bytes, name, browserBootable };
    $("m-image").textContent = `${(bytes.length / 1024).toFixed(0)} KB`;
  }

  async function bootProjectArtifact(previewSrc) {
    const t = state.config.targets.find((x) => x.id === state.target);
    if (!state.project || !state.artifacts.length) return;
    if (t.browserBootable && state.artifacts.includes("floppy.img")) {
      const res = await fetchFile(`/api/projects/${state.project.id}/artifacts/floppy.img`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      setImage(bytes, `${slug(state.project.name)}.img`, true);
      bootImage(bytes, state.project.name);
    } else {
      showPreview(previewSrc, t.builder === "linux"
        ? "This is a screenshot from the test machine. Linux builds are 64-bit, which the browser emulator can't run: use Download to get it with a ready-made QEMU script."
        : "This is a screenshot from the test machine. 64-bit OSes can't run in the browser emulator: use Download to get the image and a QEMU script.");
    }
  }

  const slug = (s) => (s || "kernelcraft").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "kernelcraft";

  $("restart").onclick = () => state.image?.browserBootable ? bootImage(state.image.bytes, state.image.name) : toast("Nothing to restart yet");
  $("cad").onclick = () => emulator?.keyboard_send_scancodes([0x1d, 0x38, 0x53, 0xd3, 0xb8, 0x9d]);
  $("lock-mouse").onclick = () => emulator ? emulator.lock_mouse() : toast("Build or boot an OS first");
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
    renderExportMenu();
    e.target.value = "";
  };
  $("demo-link").onclick = () => bootSample("showcase");

  async function bootSample(name) {
    try {
      // The showcase image is built for 1024x768 with 256 MB RAM and 16 MB VRAM.
      if (name === "showcase") { state.hardware = { ...defaultHardware(), ...(state.config.showcaseHardware || {}) }; renderHardware(); }
      const res = await fetch(STATIC ? `samples/${name}.img` : `/api/sample/${name}.img`);
      if (!res.ok) throw new Error("Could not load the demo OS");
      const bytes = new Uint8Array(await res.arrayBuffer());
      setImage(bytes, `kernelcraft-${name}-demo.img`, true);
      bootImage(bytes, "demo");
      renderExportMenu();
      if (name === "showcase") aiMsg(p("I booted a demo OS so you can see what KernelCraft makes: double-click the desktop icons, drag windows, press F1 for the start menu. When you're ready, tell me what your own OS should look like."));
    } catch (err) {
      toast(err.message);
    }
  }

  // Status bar: instructions per second from v86, page FPS from rAF.
  let lastInstr = 0, frames = 0;
  (function frame() { frames++; requestAnimationFrame(frame); })();
  setInterval(() => {
    const running = emulator && emulator.is_running();
    $("m-cpu").textContent = !emulator ? "idle" : running ? "running" : "stopped";
    $("m-dot").classList.toggle("on", Boolean(running));
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
    const link = (text, fn) => h("a", { href: "#", textContent: text, onclick: (e) => { e.preventDefault(); fn(); } });
    if (state.project) {
      for (const a of state.artifacts) {
        items.push(link(`Download ${a}`, async () => {
          try { downloadBytes(new Uint8Array(await (await fetchFile(`/api/projects/${state.project.id}/artifacts/${a}`)).arrayBuffer()), a); } catch (err) { toast(err.message); }
        }));
      }
    } else if (state.image) items.push(link(`Download ${state.image.name}`, () => downloadBytes(state.image.bytes, state.image.name)));
    if (Object.keys(state.files).length) items.push(link("Download source code (.txt)", downloadSources));
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
    if (!Object.keys(state.files).length) return toast("Nothing to run yet");
    if (!requireSignIn()) return;
    userMsg("▶ Run my code edits");
    await runBuild("/api/rebuild", { target: state.target, files: state.files, projectId: state.project?.id, hardware: hw() }, "Compiling your edits (no AI)…");
  };

  function showTab(name) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    for (const n of ["display", "code", "apps", "serial"]) $(`tab-${n}`).hidden = n !== name;
  }
  document.querySelectorAll(".tab").forEach((tab) => (tab.onclick = () => showTab(tab.dataset.tab)));

  function openLightbox(ev) {
    $("lightbox-img").hidden = !ev.screenshot;
    $("lightbox-img").src = ev.screenshot || "";
    const box = $("lightbox-text");
    box.innerHTML = "";
    box.append(h("h3", { textContent: `Test ${ev.pass}: ${ev.verdict?.pass ? "looks good" : "found problems"} — ${ev.verdict?.summary || ""}` }));
    if (ev.verdict?.issues?.length) box.append(h("ul", {}, ev.verdict.issues.map((i) => h("li", {}, h("pre", { textContent: i, style: "white-space:pre-wrap" })))));
    $("lightbox").showModal();
  }

  // ------------------------------------------------------------- composer ---
  function autosize(el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 200)}px`; }
  function enterToSubmit(el, submit) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
  }
  $("prompt").addEventListener("input", (e) => autosize(e.target));
  enterToSubmit($("prompt"), () => $("composer").requestSubmit());
  $("composer").onsubmit = (e) => {
    e.preventDefault();
    const text = $("prompt").value.trim();
    if (text) send(text);
  };

  // Home page: the prompt there starts a new OS in the builder.
  enterToSubmit($("hero-prompt"), () => $("hero-form").requestSubmit());
  $("hero-form").onsubmit = (e) => {
    e.preventDefault();
    const text = $("hero-prompt").value.trim();
    if (!text) return $("hero-prompt").focus();
    startFromHome(text);
  };
  function startFromHome(text) {
    $("hero-prompt").value = "";
    location.hash = "#/studio";
    if (state.project) newProject();
    send(text);
  }
  $("hero-chips").append(...IDEAS.slice(0, 4).map((idea) => h("span", { className: "chip", textContent: idea, onclick: () => startFromHome(idea) })));

  // Settings popover (OS type, hardware, builder server).
  function openSettings() { $("settings").hidden = false; }
  $("settings-btn").onclick = (e) => { e.stopPropagation(); $("settings").hidden = !$("settings").hidden; };
  $("settings-close").onclick = () => ($("settings").hidden = true);
  $("settings").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => ($("settings").hidden = true));

  $("server-save").onclick = async () => {
    let url = $("server-url").value.trim().replace(/\/+$/, "");
    if (url && !/^https?:\/\//.test(url)) url = `https://${url}`;
    if (!url) { server = ""; storage.set("kc_server", null); await reloadConfig(); return toast("Disconnected"); }
    try {
      const res = await fetch(`${url}/api/config`);
      if (!res.ok) throw new Error();
      await res.json();
    } catch {
      return toast("Couldn't reach that server. In Codespaces, open the Ports tab, set port 8086 to Public, and copy its address.", 9000);
    }
    server = url;
    storage.set("kc_server", url);
    await reloadConfig();
    $("settings").hidden = true;
    aiMsg(h("p", { className: "result-ok", textContent: "✓ Connected to your KernelCraft server." }), p(state.me?.user ? "Tell me what to build!" : "Create a free account on it, then tell me what to build."));
  };

  async function reloadConfig() {
    state.config = await api("/api/config");
    await refreshMe();
    renderHardware();
    renderApps();
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
    $("hw-apply").disabled = $("custom-app-btn").disabled = busy;
    $("prompt").placeholder = busy ? "The AI is working… you can type your next idea" : state.project ? "Ask for a change… e.g. “add a calculator and make it dark”" : "Describe the OS you want…";
    renderApps();
  }

  // Sends a chat message: a new OS, or a change to the open one.
  async function send(text) {
    if (state.building) return toast("Hang on, I'm still working on the last request");
    $("settings").hidden = true;
    if (offline()) {
      userMsg(text);
      $("prompt").value = "";
      if (chat.querySelector(".need-server")) aiMsg(p("Love it! I need a builder server before I can build that. Follow the steps above, then send it again."));
      else needServer();
      return;
    }
    if (!state.me?.user) {
      $("prompt").value = text;
      openAuth("signup", () => send(text));
      return;
    }
    let body;
    let note = null;
    if (state.project) {
      body = { projectId: state.project.id, change: text, hardware: hw() };
    } else {
      let target = state.targetChoice;
      if (target === "auto") ({ target, note } = autoTarget(text));
      if (!plan().targets.includes(target)) {
        userMsg(text);
        $("prompt").value = "";
        const needed = planNameFor(target);
        aiMsg(
          p(plan().targets.length ? `${SHORT[target]} OSes need the ${needed} plan.` : "Building with AI starts on the Plus plan (₹700/month). The Free plan can run demo OSes and your own .img files."),
          h("div", { className: "actions-row" }, h("a", { className: "button small primary", href: "#/pricing", textContent: "See plans" }), h("button", { className: "small", textContent: "Try a demo OS", onclick: () => bootSample("showcase") })),
        );
        return;
      }
      if (target !== state.target) {
        if ((state.target === "linux64") !== (target === "linux64")) state.hardware = null;
        state.target = target;
        state.hardware = state.hardware || defaultHardware();
      }
      body = { prompt: text, target, hardware: hw(), apps: isSdkTarget() ? [...state.selectedApps] : [] };
    }
    $("welcome-ideas")?.remove();
    userMsg(text);
    $("prompt").value = "";
    autosize($("prompt"));
    const intro = state.project ? "On it! Updating your OS…" : `${note ? `${note} ` : ""}Great idea! Building a ${SHORT[state.target]} OS for you…`;
    await runBuild("/api/build-os", body, intro);
  }

  async function runBuild(url, body, intro) {
    if (state.building) return;
    setBusy(true);
    showBuilding();
    const progress = progressBubble(intro);
    const screenshots = {};
    try {
      const res = await fetch(apiUrl(url), { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) });
      if (!(res.headers.get("content-type") || "").includes("ndjson")) {
        const err = await res.json().catch(() => ({}));
        if (err.upgrade) progress.bubble.append(h("div", { className: "actions-row" }, h("a", { className: "button small primary", href: "#/pricing", textContent: "See plans" })));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      let finished = false;
      for await (const ev of ndjson(res)) {
        if (ev.type === "log") progress.log(ev.agent, ev.message);
        else if (ev.type === "pass") { screenshots[ev.pass] = ev.screenshot; progress.pass(ev, ev.screenshot); }
        else if (ev.type === "error") { progress.log("error", ev.message); progress.fail(`Something went wrong: ${ev.message}`); finished = true; }
        else if (ev.type === "result") { await handleResult(ev, screenshots, progress); finished = true; }
      }
      if (!finished) progress.fail("The connection to the server dropped. Try again.");
    } catch (err) {
      progress.fail(`Sorry, that didn't work: ${err.message}`);
      if (!emulator && $("preview").hidden) state.project ? overlay("▣", "", "The last request didn't finish.") : showEmpty();
    } finally {
      setBusy(false);
    }
  }

  async function handleResult(result, screenshots, progress) {
    if (result.account) { state.me = result.account; renderAccount(); }
    if (result.files) setFiles(result.files);
    if (!result.projectId) {
      progress.fail("I couldn't get a version that boots this time. Try describing it a little differently, or ask for something simpler first.");
      if (!emulator) showEmpty();
      return;
    }
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
    if (result.serialLog) serialWrite(`\n--- test machine console ---\n${result.serialLog}\n`);
    const runsHere = result.browserBootable;
    progress.finish(
      result.verified,
      result.verified
        ? `✓ Done! ${project.name} is ${runsHere ? "running on the right. Click into it to use it." : "built and tested. Use Download to run it with QEMU."}`
        : `⚠ ${project.name} built, but my screen check still sees problems${runsHere ? ". It's running on the right" : ""}. Tell me what looks wrong and I'll fix it.`,
      [p("What next? Ask for any change:"), nextIdeas()],
    );
    await bootProjectArtifact(screenshots[result.finalPass]);
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
      : `${x.cpus} core${x.cpus > 1 ? "s" : ""} ${model} · ${mbText(x.ramMB)} · ${x.resolution.replace("x", "×")}`;
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
    fill("ramMB", o.ramMB, mbText);
    fill("vramMB", o.vramMB, mbText);
    fill("resolution", linux ? o.linuxResolutions : o.resolutions, (v) => v.replace("x", " × "));
    $("hw-resolution").disabled = $("hw-vramMB").disabled = state.target === "real16";
    const notes = [];
    const [w, hgt] = x.resolution.split("x").map(Number);
    if (state.target === "real16") notes.push("16-bit OSes choose their own BIOS video mode, so resolution and graphics memory don't apply.");
    else if (w * hgt * 4 > x.vramMB * 1048576) notes.push(`${x.resolution} needs more graphics memory; it will be raised automatically.`);
    if (x.cpus > 1 && !linux) notes.push("Extra cores show up in the OS; the SDK schedules on the first core (ask the AI to add SMP).");
    const lim = o.limits;
    if (x.ramMB > lim.vmRamMB) notes.push(`The test VM gets ${mbText(lim.vmRamMB)}; the downloaded run-qemu.sh uses the full ${mbText(x.ramMB)}.`);
    if (!linux && x.ramMB > lim.sdkRamMB) notes.push(`SDK kernels use up to ${mbText(lim.sdkRamMB)} of RAM (Linux uses all of it).`);
    if (x.vramMB > lim.vgaVramMB) notes.push(`The emulated graphics card holds up to ${mbText(lim.vgaVramMB)}.`);
    if (!linux && state.target !== "long64" && (x.ramMB > 1024 || x.vramMB > 128)) notes.push("In this browser tab the emulator runs with up to 1 GB RAM and 128 MB graphics memory.");
    $("hw-note").textContent = notes.join(" ");
    const changed = state.project && !sameHardware(x, { ...defaultHardware(), ...(state.project.hardware || {}) });
    $("hw-apply").hidden = !changed;
    renderSettingsSummary();
    if (state.project) $("project-sub").textContent = `${targetLabel(state.project.target)} · ${hwText(x)}`;
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
    $("settings").hidden = true;
    userMsg(`Change the hardware to ${hwText(hw())}`);
    await runBuild("/api/rebuild", { target: state.target, files: state.files, projectId: state.project.id, hardware: hw() }, "Rebuilding with the new hardware (no AI needed)…");
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
      ? "Ready-made apps are for 32-bit and 64-bit desktops."
      : state.project ? "Adding or removing one rebuilds your OS without an AI build." : "Picked apps are included in your first build.";
    $("custom-app").placeholder = state.target === "linux64" ? "A terminal to-do list app that saves to /home" : "A to-do list app with checkboxes and due dates";
    for (const a of state.config.apps) {
      const on = state.project ? installed(a.id) : state.selectedApps.has(a.id);
      const btn = h("button", { className: `small ${on ? "added" : ""}`, textContent: on ? (state.project ? "Installed · Remove" : "✓ Added") : "Add", disabled: !sdk || state.building });
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
    state.files = files;
    renderFileList();
    userMsg(`${on ? "Remove" : "Add"} the ${app.name} app`);
    await runBuild("/api/rebuild", { target: state.target, files, projectId: state.project.id, hardware: hw() }, `${on ? "Removing" : "Installing"} ${app.name}…`);
  }

  $("custom-app-form").onsubmit = (e) => {
    e.preventDefault();
    const idea = $("custom-app").value.trim();
    if (!idea) return toast("Describe the app first");
    $("custom-app").value = "";
    showTab("display");
    send(state.project ? `Add a new app: ${idea}` : `A desktop OS with this app: ${idea}`);
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
    if (STATIC) {
      document.body.classList.add("static");
      $("server-block").hidden = false;
      $("server-url").value = server;
    }
    try {
      state.config = await api("/api/config");
    } catch {
      // A saved server that's gone (stopped codespace): fall back to the demo.
      server = "";
      state.config = await api("/api/config");
      toast("Your KernelCraft server isn't reachable. Start it again and reconnect in ⚙ Settings.", 8000);
    }
    state.hardware = defaultHardware();
    await refreshMe();
    renderHardware();
    renderApps();
    renderProjectHead();
    route();
  })();
})();
