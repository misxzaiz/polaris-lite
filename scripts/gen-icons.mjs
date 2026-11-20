#!/usr/bin/env node
/**
 * gen-icons.mjs：生成 PWA 图标（public/icons/icon-{192,512}.png + icon-maskable-512.png）。
 *
 * 零依赖：用 node:zlib 手写 PNG 编码，星形 Logo 以多边形光栅化（4x 超采样抗锯齿）。
 * 形状复刻 Brand 的视觉（外四芒星 + 内填充星），浅色底 + 深色前景（theme_color #ffffff）。
 *
 * 用法：node scripts/gen-icons.mjs   （幂等，重复执行覆盖）
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ---- PNG 编码（最小实现：RGBA8、filter 0）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 每行前置 filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- 四芒星多边形（复刻 Brand：外 N/E/S/W 尖 + 内斜向四点）----
// 中心 (0,0)，size 为整幅图标边长；outer/inner 为星形外内半径比例（相对 size）
function starPolygon(size, outerRatio, innerRatio) {
  const R = (size / 2) * outerRatio;
  const r = (size / 2) * innerRatio;
  // y 轴向下；顶点顺序：外 N、内 NE、外 E、内 SE、外 S、内 SW、外 W、内 NW
  return [
    [0, -R], [r * Math.SQRT1_2, -r * Math.SQRT1_2], [R, 0], [r * Math.SQRT1_2, r * Math.SQRT1_2],
    [0, R], [-r * Math.SQRT1_2, r * Math.SQRT1_2], [-R, 0], [-r * Math.SQRT1_2, -r * Math.SQRT1_2],
  ].map(([x, y]) => [x + size / 2, y + size / 2]);
}
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- 渲染：底色白、外星描边感（深色实心）、内星淡填充 ----
const BG = [255, 255, 255, 255];
const FG = [17, 17, 20, 255];       // #111114（对齐深色主题前景）
const INNER = [17, 17, 20, 60];     // 内星 ~0.24 透明度

function renderIcon(size, { maskable = false } = {}) {
  // maskable：星形整体缩到 80% 安全区内（四周留白给系统裁切）
  const scale = maskable ? 0.62 : 0.84;
  const outer = starPolygon(size, 1.0 * scale, 1.0 * scale * (4 / 13.5)); // 内半径比 ≈ 4/13.5（对齐 Brand 坐标）
  const inner = starPolygon(size, 0.5 * scale, 0.5 * scale * (4 / 13.5));
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // 4x 超采样
      let covOuter = 0;
      let covInner = 0;
      for (let sy = 0; sy < 2; sy += 1) {
        for (let sx = 0; sx < 2; sx += 1) {
          const px = x + (sx + 0.5) / 2;
          const py = y + (sy + 0.5) / 2;
          if (pointInPoly(px, py, inner)) covInner += 1;
          if (pointInPoly(px, py, outer)) covOuter += 1;
        }
      }
      const fo = covOuter / 4;
      const fi = covInner / 4;
      // 合成：底 → 内星淡色 → 外星实色
      let r = BG[0], g = BG[1], b = BG[2];
      // 内星先铺（在外星下层）
      r = Math.round(r * (1 - fi) + INNER[0] * fi);
      g = Math.round(g * (1 - fi) + INNER[1] * fi);
      b = Math.round(b * (1 - fi) + INNER[2] * fi);
      r = Math.round(r * (1 - fo) + FG[0] * fo);
      g = Math.round(g * (1 - fo) + FG[1] * fo);
      b = Math.round(b * (1 - fo) + FG[2] * fo);
      const o = (y * size + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'icon-192.png'), renderIcon(192));
writeFileSync(resolve(outDir, 'icon-512.png'), renderIcon(512));
writeFileSync(resolve(outDir, 'icon-maskable-512.png'), renderIcon(512, { maskable: true }));
console.log(`ok  icons → public/icons/ (192 / 512 / maskable-512)`);
