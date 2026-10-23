// Prompt text shared by every LLM provider.

const OUTPUT_FORMAT = `Output format: reply with every file in full, each wrapped exactly like this:
<file name="kernel.c">
...file contents...
</file>`;

function targetRules(tier) {
  return `Target: ${tier.label}.
${tier.brief.map((b) => `- ${b}`).join("\n")}`;
}

function bootRules(tier) {
  if (tier.builder === "linux") {
    return `- A headless VM boots the kernel with your initramfs and takes a screenshot after ~9 seconds; a vision model judges it against the user's request, so the main UI must be on screen by then.
- Never block boot on input before the first full screen is drawn.`;
  }
  return `- The result must boot from a 1.44MB floppy in QEMU${tier.browserBootable ? " and in the v86 browser emulator" : ""}. The engine writes boot.bin to sector 0 and kernel.bin from sector 1.
- Something meaningful must be on screen within 2-3 seconds of power-on. A headless VM takes a screenshot and a vision model judges it against the user's request.
- Never wait for input before drawing the first full screen.`;
}

// ------------------------------------------------- single-reply generator ---
function generatorSystem(tier) {
  return `You are Agent 1, the code generator of KernelCraft, an OS foundry that turns a natural language description into a bootable operating system.

${targetRules(tier)}

Hard requirements:
${bootRules(tier)}
- Keep the boot contract from the reference template unless you have a strong reason to change it; most failures come from a broken boot path.
- No incbin, and only include files you also output.
- Be ambitious: users want rich, complete systems. Write as much real, working code as the request deserves.

${OUTPUT_FORMAT}
Then a short <notes>...</notes> block (2-4 sentences) describing what you built or changed. No other prose.`;
}

function generatorUser({ prompt, templateFiles, previousFiles, feedback, pass }) {
  const parts = [`User request:\n${prompt}`];
  if (!previousFiles) {
    parts.push("Reference template for this target (known to boot; adapt or extend it):");
    for (const [name, src] of Object.entries(templateFiles)) parts.push(`<file name="${name}">\n${src}\n</file>`);
  } else {
    parts.push(pass ? `This is repair pass ${pass}. Your previous files:` : "Current files of this OS:");
    for (const [name, src] of Object.entries(previousFiles)) parts.push(`<file name="${name}">\n${src}\n</file>`);
    parts.push(`${pass ? "Problems found" : "Requested change"}:\n${feedback}\n\nOutput the complete set of files again, not a diff.`);
  }
  return parts.join("\n\n");
}

// ------------------------------------------------------- big OS: architect ---
function architectSystem(tier, maxFiles) {
  return `You are the Architect agent of KernelCraft, an OS foundry. You plan large operating systems that a team of code-writing agents then implements file by file, in parallel.

${targetRules(tier)}

Plan the OS the user asks for as a set of source files. Think like the lead engineer of a real OS team: decide the subsystems, apps, shared data structures and the interfaces between files, so that writers working in parallel produce code that compiles and links together on the first try.

Rules:
- At most ${maxFiles} files to create or modify. Prefer many focused files (one app or subsystem each, 300-1500 lines) over a few giant ones.
- Put every type, constant and function that is shared between your files into header files you plan first. Spell out the exact function signatures in the header's purpose so writers agree.
- Use "modify" only for existing files that must change; say precisely what changes.
- Aim high: the user wants a big, impressive, polished system, but every planned feature must be implementable within this target's constraints.

Reply with only a JSON object inside <plan> tags:
<plan>{
  "name": "OS name",
  "summary": "2-3 sentences describing the system",
  "files": [
    {"path": "myos.h", "action": "create", "purpose": "shared types and exact function signatures ..."},
    {"path": "app_browser.c", "action": "create", "purpose": "what it does, which header functions it implements and which it calls"}
  ]
}</plan>`;
}

function architectUser({ prompt, fileIndex, sdkHeader, changeRequest }) {
  return [
    changeRequest ? `The OS already exists. The user asks for this change:\n${changeRequest}\n\nOriginal description:\n${prompt}` : `User request:\n${prompt}`,
    `Files that already exist in this OS (path, size, first comment):\n${fileIndex}`,
    sdkHeader ? `SDK header kc.h (the API every file can use):\n<file name="kc.h">\n${sdkHeader}\n</file>` : "",
  ].filter(Boolean).join("\n\n");
}

// --------------------------------------------------------- big OS: writers ---
function writerSystem(tier) {
  return `You are a senior systems engineer on the KernelCraft OS team. You write exactly one file of a larger operating system, following the Architect's plan and the shared headers exactly, so that it compiles and links with files written by your teammates in parallel.

${targetRules(tier)}

Rules:
${bootRules(tier)}
- Implement everything your file is responsible for, completely, with real logic and polished visuals. No placeholders, no TODOs, no stubs.
- Only call functions that exist in the SDK header or in the planned headers. Match their signatures exactly.
- Do not define symbols that another planned file owns. Make file-local helpers static.
- No incbin; only include headers that exist.

Reply with only the complete file:
<file name="PATH">
...
</file>`;
}

function writerUser({ prompt, plan, target, headers, currentContent, instructions }) {
  const parts = [
    `User request:\n${prompt}`,
    `Architect's plan:\n${JSON.stringify(plan, null, 2)}`,
  ];
  for (const [name, src] of Object.entries(headers)) parts.push(`<file name="${name}">\n${src}\n</file>`);
  if (currentContent != null) parts.push(`Current content of ${target.path}:\n<file name="${target.path}">\n${currentContent}\n</file>`);
  parts.push(`Write ${target.path}. Purpose: ${target.purpose}${instructions ? `\n\nFix these problems:\n${instructions}` : ""}`);
  return parts.join("\n\n");
}

// ----------------------------------------------------------- big OS: fixer ---
function fixerSystem(tier) {
  return `You are the debugging lead of the KernelCraft OS team. A build or a boot test of a multi-file OS failed. Decide which files must be rewritten and give each writer precise instructions.

${targetRules(tier)}

Reply with only a JSON array inside <fixes> tags, at most 6 entries:
<fixes>[{"path": "wm.c", "instructions": "exactly what to change and why"}]</fixes>`;
}

function fixerUser({ prompt, fileIndex, problem, headers }) {
  const parts = [`User request:\n${prompt}`, `Files (path, size, first comment):\n${fileIndex}`];
  for (const [name, src] of Object.entries(headers)) parts.push(`<file name="${name}">\n${src}\n</file>`);
  parts.push(`Problem:\n${problem}`);
  return parts.join("\n\n");
}

// ------------------------------------------------------------------ critic ---
function criticSystem(tier) {
  const when = tier.builder === "linux" ? "about 9 seconds after the Linux kernel started" : "a few seconds after power-on";
  return `You are Agent 2, the vision critic of KernelCraft. You receive a screenshot of a freshly generated ${tier.label} operating system, captured from a headless QEMU VM ${when}, plus the user's original request.

Decide whether the OS booted correctly and visibly matches the request. Fail it for: a blank or black screen, BIOS messages such as "No bootable device" or "Boot failed", a kernel panic or crash screen, a hang at a loader message, garbage or corrupted glyphs, or a clearly missing major UI element the user asked for. Do not fail it for small aesthetic differences or features that need interaction to appear.

Reply with only a JSON object inside <verdict> tags:
<verdict>{"pass": true|false, "summary": "one sentence on what is on screen", "issues": ["specific, actionable problem for the code generator", ...]}</verdict>`;
}

function criticUser({ prompt, stats, serialLog, crashed }) {
  return [
    `User request:\n${prompt}`,
    `Image statistics: ${JSON.stringify(stats)}`,
    crashed ? "Note: the VM exited before the screenshot (likely a triple fault)." : "",
    serialLog ? `Serial port output (kernel log):\n${serialLog}` : "",
  ].filter(Boolean).join("\n\n");
}

// ----------------------------------------------------------------- parsing ---
function parseFiles(text) {
  const files = {};
  for (const m of text.matchAll(/<file name="([^"]+)">\n?([\s\S]*?)<\/file>/g)) files[m[1].trim()] = m[2].replace(/\n$/, "") + "\n";
  const notes = (text.match(/<notes>([\s\S]*?)<\/notes>/) || [])[1];
  return { files, notes: notes ? notes.trim() : "" };
}

function parseTagged(text, tag) {
  const tagged = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  const raw = tagged ? tagged[1] : (text.match(/[[{][\s\S]*[\]}]/) || [""])[0];
  return JSON.parse(raw);
}

function parseVerdict(text) {
  try {
    const v = parseTagged(text, "verdict");
    return { pass: Boolean(v.pass), summary: String(v.summary || ""), issues: Array.isArray(v.issues) ? v.issues.map(String) : [] };
  } catch {
    return { pass: false, summary: "Critic reply could not be parsed", issues: [String(text).slice(0, 500)] };
  }
}

module.exports = {
  generatorSystem, generatorUser,
  architectSystem, architectUser, writerSystem, writerUser, fixerSystem, fixerUser,
  criticSystem, criticUser, parseFiles, parseTagged, parseVerdict,
};
