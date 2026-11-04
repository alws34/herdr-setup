// Where the browser pane is inside Herdr's window. A mod can't ask for its own position,
// so the pane paints a 4x4 px square of MARKER in its top-left and bottom-right corners
// and this finds them in `herdr-app shot` (Herdr's own last frame, which still has them
// under our window). Node built-ins only; `node marker.cjs <png> [r,g,b]` prints what it finds.
// Each browser block on screen at once (the Browser tool, open canvases) paints its own color.
const { inflateSync } = require("node:zlib");

const MARKER = [254, 1, 253];
const near = (a, b) => Math.abs(a - b) <= 3;

// 8-bit RGB/RGBA, non-interlaced: what herdr-app shot writes.
function decode(buf) {
  let w = 0, h = 0, type = 0, idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), kind = buf.toString("ascii", o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (kind === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9];
      if (data[8] !== 8 || data[12] !== 0 || (type !== 2 && type !== 6)) throw new Error("unsupported PNG");
    } else if (kind === "IDAT") idat.push(data);
    o += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0, b = y ? px[up + x] : 0, c = x >= bpp && y ? px[up + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v;
    }
  }
  return { w, h, bpp, px };
}

// The pane's box in shot pixels: from the first marker pixel to the last one.
function findMarker(buf, color = MARKER) {
  const { w, h, bpp, px } = decode(buf);
  const hit = (i) => near(px[i], color[0]) && near(px[i + 1], color[1]) && near(px[i + 2], color[2]);
  let first = -1, last = -1;
  for (let i = 0, n = w * h; i < n; i++) if (hit(i * bpp)) { if (first < 0) first = i; last = i; }
  if (first < 0) return null;
  const x0 = first % w, y0 = Math.floor(first / w), x1 = last % w, y1 = Math.floor(last / w);
  return { shotWidth: w, x: x0, y: y0, width: x1 + 1 - x0, height: y1 + 1 - y0 };
}

module.exports = { findMarker, MARKER };
if (require.main === module) console.log(JSON.stringify(findMarker(require("node:fs").readFileSync(process.argv[2]), process.argv[3]?.split(",").map(Number))));
