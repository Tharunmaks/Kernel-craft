// Minimal PPM (P6) reader and PNG encoder, so QEMU screendumps can be shown
// in the browser and sent to vision models without native image libraries.
const zlib = require("zlib");

function parsePPM(buf) {
  let pos = 0;
  const tokens = [];
  while (tokens.length < 4) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
    if (buf[pos] === 0x23) { // '#' comment
      while (pos < buf.length && buf[pos] !== 0x0a) pos++;
      continue;
    }
    const start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    tokens.push(buf.toString("ascii", start, pos));
  }
  pos++; // single whitespace after maxval
  const [magic, w, h, max] = tokens;
  if (magic !== "P6" || Number(max) !== 255) throw new Error(`Unsupported PPM (${magic}, max ${max})`);
  const width = Number(w), height = Number(h);
  return { width, height, rgb: buf.subarray(pos, pos + width * height * 3) };
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG({ width, height, rgb }) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Cheap signals the critic gets before any model looks at the image.
function imageStats({ width, height, rgb }) {
  const colours = new Map();
  let lit = 0;
  for (let i = 0; i < rgb.length; i += 3 * 7) { // sample every 7th pixel
    const key = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
    colours.set(key, (colours.get(key) || 0) + 1);
    if (rgb[i] + rgb[i + 1] + rgb[i + 2] > 48) lit++;
  }
  const samples = Math.ceil(rgb.length / 21);
  const dominant = Math.max(...colours.values()) / samples;
  return {
    width,
    height,
    distinctColours: colours.size,
    dominantColourShare: Number(dominant.toFixed(3)),
    litShare: Number((lit / samples).toFixed(3)),
    blank: colours.size <= 1 || dominant > 0.995,
  };
}

module.exports = { parsePPM, encodePNG, imageStats };
