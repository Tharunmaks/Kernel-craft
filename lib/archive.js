// Minimal archive writers: cpio "newc" (Linux initramfs) and ustar (exports).
// entries: [{ path: "bin/sh", type: "file"|"dir"|"symlink", mode, data: Buffer, target }]

function pad4(n) { return (4 - (n % 4)) % 4; }
function hex8(n) { return n.toString(16).padStart(8, "0"); }

function cpioNewc(entries) {
  const parts = [];
  let ino = 1;
  const add = (name, mode, data) => {
    const nameBuf = Buffer.from(name + "\0");
    const header = "070701" + [
      ino++, mode, 0, 0, 1, Math.floor(Date.now() / 1000), data.length, 0, 0, 0, 0, nameBuf.length, 0,
    ].map(hex8).join("");
    parts.push(Buffer.from(header, "ascii"), nameBuf, Buffer.alloc(pad4(110 + nameBuf.length)));
    parts.push(data, Buffer.alloc(pad4(data.length)));
  };
  for (const e of entries) {
    if (e.type === "dir") add(e.path, 0o040000 | (e.mode ?? 0o755), Buffer.alloc(0));
    else if (e.type === "symlink") add(e.path, 0o120000 | 0o777, Buffer.from(e.target));
    else add(e.path, 0o100000 | (e.mode ?? 0o644), e.data);
  }
  add("TRAILER!!!", 0, Buffer.alloc(0));
  return Buffer.concat(parts);
}

function tar(entries) {
  const parts = [];
  for (const e of entries) {
    const header = Buffer.alloc(512);
    const name = e.type === "dir" && !e.path.endsWith("/") ? e.path + "/" : e.path;
    if (Buffer.byteLength(name) > 99) throw new Error(`tar path too long: ${name}`);
    const size = e.type === "file" ? e.data.length : 0;
    header.write(name, 0, "utf8");
    header.write((e.mode ?? (e.type === "dir" ? 0o755 : 0o644)).toString(8).padStart(7, "0") + "\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(size.toString(8).padStart(11, "0") + "\0", 124);
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
    header.write("        ", 148);
    header.write(e.type === "dir" ? "5" : "0", 156);
    header.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header);
    if (size) parts.push(e.data, Buffer.alloc((512 - (size % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

module.exports = { cpioNewc, tar };
