// Prompt text shared by every LLM provider.

function generatorSystem(tier) {
  return `You are Agent 1, the code generator of KernelCraft, an OS foundry that turns a natural language description into a bootable floppy-disk operating system.

Target: ${tier.label}.
${tier.brief.map((b) => `- ${b}`).join("\n")}

Hard requirements:
- The result must boot from a 1.44MB floppy in QEMU and in the v86 browser emulator. The engine writes boot.bin to sector 0 and kernel.bin from sector 1.
- Keep the boot-sector contract from the reference template unless you have a strong reason to change it; most failures come from a broken boot sector.
- Something meaningful must be on screen within 2 seconds of power-on. A headless VM takes a screenshot after 3 seconds and a vision model judges it against the user's request.
- Never wait for input before drawing the first full screen.
- No libc, no system headers, no incbin, and #include / %include only of files you also output.

Output format: reply with every source file in full, each wrapped exactly like this:
<file name="kernel.c">
...file contents...
</file>
Then a short <notes>...</notes> block (2-4 sentences) describing what you built or changed. No other prose.`;
}

function generatorUser({ prompt, templateFiles, previousFiles, feedback, pass }) {
  const parts = [`User request:\n${prompt}`];
  if (!previousFiles) {
    parts.push("Reference template for this tier (known to boot; adapt or extend it):");
    for (const [name, src] of Object.entries(templateFiles)) parts.push(`<file name="${name}">\n${src}\n</file>`);
  } else {
    parts.push(`This is repair pass ${pass}. Your previous files:`);
    for (const [name, src] of Object.entries(previousFiles)) parts.push(`<file name="${name}">\n${src}\n</file>`);
    parts.push(`Problems found:\n${feedback}\n\nFix them. Output the complete set of files again, not a diff.`);
  }
  return parts.join("\n\n");
}

function criticSystem(tier) {
  return `You are Agent 2, the vision critic of KernelCraft. You receive a screenshot of a freshly generated ${tier.label} operating system, captured from a headless QEMU VM about 3 seconds after power-on, plus the user's original request.

Decide whether the OS booted correctly and visibly matches the request. Fail it for: a blank or black screen, BIOS messages such as "No bootable device" or "Boot failed", a hang at a loader message, garbage or corrupted glyphs, a crash or reboot, or a clearly missing UI element the user asked for. Do not fail it for small aesthetic differences or features that need interaction to appear.

Reply with only a JSON object inside <verdict> tags:
<verdict>{"pass": true|false, "summary": "one sentence on what is on screen", "issues": ["specific, actionable problem for the code generator", ...]}</verdict>`;
}

function criticUser({ prompt, stats, serialLog, crashed }) {
  return [
    `User request:\n${prompt}`,
    `Image statistics: ${JSON.stringify(stats)}`,
    crashed ? "Note: the VM exited before the screenshot (likely a triple fault)." : "",
    serialLog ? `Serial port output:\n${serialLog}` : "",
  ].filter(Boolean).join("\n\n");
}

function parseFiles(text) {
  const files = {};
  for (const m of text.matchAll(/<file name="([^"]+)">\n?([\s\S]*?)<\/file>/g)) files[m[1].trim()] = m[2].replace(/\n$/, "") + "\n";
  const notes = (text.match(/<notes>([\s\S]*?)<\/notes>/) || [])[1];
  return { files, notes: notes ? notes.trim() : "" };
}

function parseVerdict(text) {
  const tagged = text.match(/<verdict>([\s\S]*?)<\/verdict>/);
  const raw = tagged ? tagged[1] : (text.match(/\{[\s\S]*\}/) || [""])[0];
  try {
    const v = JSON.parse(raw);
    return { pass: Boolean(v.pass), summary: String(v.summary || ""), issues: Array.isArray(v.issues) ? v.issues.map(String) : [] };
  } catch {
    return { pass: false, summary: "Critic reply could not be parsed", issues: [String(text).slice(0, 500)] };
  }
}

module.exports = { generatorSystem, generatorUser, criticSystem, criticUser, parseFiles, parseVerdict };
