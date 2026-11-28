/**
 * media-push 插件的服务端半边：AI 把电脑上的任意文件推送到对话给用户看。
 * docs/media-push-plan.md（P0-P2 全量 + §7 交互）。
 *
 * 形态（对齐 image-push 的「工具只传引用，内容不过模型」纪律，泛型化到任意类型）：
 *   POST /api/media/push    { path, cwd?, title?, sessionId? } → { ok, id, url, kind, ext, mime, bytes, title }
 *                          服务端读文件 + 魔数嗅探（不信任扩展名）+ 落盘 + metadata.json；
 *                          kind: image/video/audio/sheet/pdf/text/archive/other。
 *   GET  /api/media/:file   文件直出（Content-Type 按落盘扩展名；cookie/本地 Bearer 门禁；
 *                          uuid 命名防穿越；视频/音频支持 Range，<video> 拖进度条需要）。
 *   GET  /api/media/:id/meta    卡片初始化元数据（文本卡截断预览 / 归档目录树）。
 *   GET  /api/media/:id/table  sheet 切片（csv/tsv 服务端解析：offset/limit/sort/filter）。
 *   GET  /api/media/:id/text   文本切片（前 256KB 首屏 + 按需续读）。
 *   GET  /api/media/:id/zip    归档目录树（zip central directory 前置解析，前 200 项）。
 *
 * 落盘：<dataDir>/media-push/<uuid>.<嗅探ext> + 同名 .json 元数据。
 *
 * 设计要点：
 * - 魔数嗅探不信任扩展名（.jpg 实为 WebP、xlsx 是 zip 头是常态）；kind 由内容决定。
 * - 尺寸闸：图片 25MB（同 image-push）；音视频 500MB；表格/文本/归档 200MB。
 * - xlsx 不做完整解析：kind 判定看 zip 头 + xl/ 目录签名（EOCD 前扫）；cell 解析放
 *   P2 后置（当前 sheet 切片端点只服务 csv/tsv，xlsx 卡给下载 + 元信息）。
 * - 归档目录树：zip central directory 简易扫描（EOCD 定位 + 名字表读取），不整体解压。
 * - 公式不执行：csv/tsv 纯文本解析，单元格按字面量返回。
 * - 无 TTL/GC：与 image-push/previews 同策略常驻数据目录（宿主数据目录随备份走）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerPushMediaTool } from './tool.mjs';

/** 各 kind 尺寸闸（字节）：图片对齐 image-push；音视频给足量；其余防 DOM/内存爆 */
const MAX_BYTES = {
  image: 25 * 1024 * 1024,
  video: 500 * 1024 * 1024,
  audio: 500 * 1024 * 1024,
  sheet: 200 * 1024 * 1024,
  pdf: 200 * 1024 * 1024,
  text: 200 * 1024 * 1024,
  archive: 200 * 1024 * 1024,
  other: 500 * 1024 * 1024,
};

/** 落盘文件名白名单（uuid + 嗅探扩展名；GET 侧拼路径前校验，天然防穿越） */
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|avif|mp4|mov|webm|mkv|m4a|mp3|wav|ogg|flac|csv|tsv|xlsx|pdf|txt|log|json|md|js|mjs|ts|tsx|css|html|py|sh|yaml|yml|zip)$/;

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  csv: 'text/csv', tsv: 'text/tab-separated-values', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  txt: 'text/plain', log: 'text/plain', json: 'application/json', md: 'text/markdown',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript',
  css: 'text/css', html: 'text/html', py: 'text/x-python', sh: 'text/x-shellscript',
  yaml: 'text/yaml', yml: 'text/yaml',
  zip: 'application/zip',
};

/** 文本类扩展名集合（kind=text 时落盘保留原扩展以助高亮） */
const TEXT_EXTS = new Set(Object.keys(MIME_BY_EXT).filter((e) => (MIME_BY_EXT[e] ?? '').startsWith('text/') || ['json'].includes(e)));

// ==================== 魔数嗅探：kind 判定 ====================

/** bytes → { kind, ext, mime }。扩展名只是落盘名，内容说了算。 */
function sniffMedia(buf) {
  const latin = (s, e) => buf.toString('latin1', s, e ?? buf.length);
  const len = buf.length;

  // ---- 图片 ----
  if (len >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { kind: 'image', ext: 'png' };
  if (len >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', ext: 'jpg' };
  if (len >= 12 && latin(0, 4) === 'RIFF' && latin(8, 12) === 'WEBP') return { kind: 'image', ext: 'webp' };
  if (len >= 6 && (latin(0, 6) === 'GIF87a' || latin(0, 6) === 'GIF89a')) return { kind: 'image', ext: 'gif' };
  if (len >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return { kind: 'image', ext: 'bmp' };

  // ---- PDF ----
  if (len >= 5 && latin(0, 5) === '%PDF-') return { kind: 'pdf', ext: 'pdf' };

  // ---- 归档（zip 家族含 xlsx/docx/pptx；xlsx 归 sheet，其余归 archive）----
  const isZip = len >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
  if (isZip) {
    // xlsx 判定：local file header 之后第一个文件名通常是 xl/ 前置（标准 Office OOXML 排布）
    // 直接在头 4KB 内找 'xl/' 字样——简单但对 OOXML 足够可靠（docx 是 word/，pptx 是 ppt/）
    const head = latin(0, Math.min(4096, len));
    if (head.includes('xl/')) return { kind: 'sheet', ext: 'xlsx' };
    return { kind: 'archive', ext: 'zip' };
  }
  if (len >= 7 && latin(0, 7) === 'Rar!\x1a\x07') return { kind: 'archive', ext: 'zip' }; // rar 归 archive，下载兜底

  // ---- 音频 ----
  if (len >= 3 && latin(0, 3) === 'ID3') return { kind: 'audio', ext: 'mp3' };
  if (len >= 12 && latin(0, 4) === 'RIFF' && latin(8, 12) === 'WAVE') return { kind: 'audio', ext: 'wav' };
  if (len >= 4 && latin(0, 4) === 'OggS') return { kind: 'audio', ext: 'ogg' };
  if (len >= 4 && latin(0, 4) === 'fLaC') return { kind: 'audio', ext: 'flac' };

  // ---- ISOBMFF ftyp box：视频品牌 / m4a 音频 / avif 图片 ----
  if (len >= 12 && latin(4, 8) === 'ftyp') {
    const brand = latin(8, 12);
    if (/^(avif|avis|heic|heix|mif1)/.test(brand)) return { kind: 'image', ext: 'avif' };
    if (brand === 'M4A ' || brand === 'M4B ') return { kind: 'audio', ext: 'm4a' };
    if (/^(mp42|mp41|isom|iso2|avc1|dash|MSNV|3gp\d)/.test(brand)) return { kind: 'video', ext: 'mp4' };
    if (/^(qt  )/.test(brand)) return { kind: 'video', ext: 'mov' };
    if (brand === 'webm') return { kind: 'video', ext: 'webm' };
    // 未知 ftyp 品牌：按容器大概率是视频，给 mp4 直出让浏览器自己试
    return { kind: 'video', ext: 'mp4' };
  }
  if (len >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { kind: 'video', ext: 'webm' }; // EBML（webm/mkv）

  // ---- 表格（csv/tsv：纯文本多列）----
  const t = tryDecodeText(buf);
  if (t) {
    const firstLine = t.slice(0, t.indexOf('\n') === -1 ? Math.min(t.length, 8192) : t.indexOf('\n'));
    if (firstLine.includes('\t')) return { kind: 'sheet', ext: 'tsv' };
    // csv 启发式：首行含逗号且逗号数 ≥2（至少 3 列，避免把含逗号句子当 csv）
    const commas = (firstLine.match(/,/g) || []).length;
    if (commas >= 2) return { kind: 'sheet', ext: 'csv' };
    return { kind: 'text', ext: 'txt' };
  }

  // ---- 兜底 ----
  return { kind: 'other', ext: 'bin' };
}

/** UTF-8 可解码且无 BOM/高比例二进制替换符 → 文本；否则 null（二进制） */
function tryDecodeText(buf, sample = 8192) {
  const cut = buf.subarray(0, Math.min(sample, buf.length));
  const s = cut.toString('utf8');
  // 解码非合法 UTF-8 会出 U+FFFD；占比超 2% 判二进制
  let bad = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0xfffd) bad++;
  if (s.length && bad / s.length > 0.02) return null;
  // 全零/控制字符密集区也判二进制
  let ctrl = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 9 || (c > 13 && c < 32)) ctrl++; }
  if (s.length && ctrl / s.length > 0.1) return null;
  return s;
}

// ==================== csv/tsv 服务端解析（切片/排序/筛选） ====================

/** 极简 RFC4180：处理引号包裹与内嵌逗号；不支持多行单元格（够账单/导出场景）。 */
function splitDelimited(line, delim) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"' && cur === '') inQ = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseTable(text, delim) {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return { header: [], rows: [] };
  const header = splitDelimited(lines[0], delim);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitDelimited(lines[i], delim);
    // 尾部空列裁齐到表头宽（trailing delimiter 常态）
    while (cells.length > header.length && cells[cells.length - 1] === '') cells.pop();
    rows.push(cells);
  }
  return { header, rows };
}

// ==================== zip central directory 目录树（不整体解压） ====================

function listZipEntries(buf) {
  // EOCD（End of Central Directory）：尾部 22 字节起向回找签名 0x06054b50
  const minTail = Math.min(buf.length, 22 + 65536);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - minTail && i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length) break;
    if (!(buf[off] === 0x50 && buf[off + 1] === 0x4b && buf[off + 2] === 0x01 && buf[off + 3] === 0x02)) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const compSize = buf.readUInt32LE(off + 20);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (name) entries.push({ name, size: compSize, dir: name.endsWith('/') });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

// ==================== 工厂 ====================

export function createServerPart(options = {}) {
  if (options.registry) registerPushMediaTool(options.registry);
  const getSession = options.getSession;
  const verifyTempToken = options.verifyTempToken ?? (() => false);
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const root = resolve(dataDir, 'media-push');

  const metaPath = (id) => join(root, `${id}.json`);
  const readMeta = (id) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const p = metaPath(id);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  };

  return async function mediaPushApi(req, res, next) {
    const [pathname, qs] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/media/')) return next?.();

    // 登录门禁：会话 cookie 或本地回环 Bearer（与 image-preview/html-preview 同一纪律）
    const authHeader = String(req.headers?.authorization ?? '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const bearerValid = !!(bearerToken && verifyTempToken(bearerToken));
    const session = getSession?.(req);
    if (!session && !bearerValid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    const sendJson = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const readBody = (maxBytes = 1024 * 1024) => new Promise((r) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size <= maxBytes) chunks.push(c); else req.destroy(); });
      req.on('end', () => r(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => r(''));
    });
    const q = new URLSearchParams(qs ?? '');

    // ---- POST /api/media/push：读文件 → 嗅探 → 落盘（工具 loopback 入口） ----
    if (pathname === '/api/media/push' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody()) || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
      const rawPath = String(body.path ?? '').trim();
      if (!rawPath) return sendJson(400, { error: '缺少 path（文件的本地路径）', code: 'PATH_REQUIRED' });
      const cwd = String(body.cwd ?? '') || process.cwd();
      const real = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
      let st;
      try { st = statSync(real); } catch { return sendJson(400, { error: `文件不存在或不可读：${real}`, code: 'NOT_FOUND' }); }
      if (!st.isFile()) return sendJson(400, { error: '不是常规文件', code: 'NOT_FILE' });
      let buf;
      try { buf = readFileSync(real); } catch (e) { return sendJson(400, { error: `读取失败：${e.message}`, code: 'READ_FAILED' }); }
      const sniff = sniffMedia(buf);
      const max = MAX_BYTES[sniff.kind] ?? MAX_BYTES.other;
      if (st.size > max) {
        return sendJson(400, { error: `文件过大（${Math.round(st.size / 1024 / 1024)}MB > ${Math.round(max / 1024 / 1024)}MB 上限，kind=${sniff.kind}）`, code: 'TOO_LARGE' });
      }
      mkdirSync(root, { recursive: true });
      const id = randomUUID();
      const ext = sniff.kind === 'text' ? (guessTextExt(real) || 'txt') : sniff.ext;
      const file = `${id}.${ext}`;
      writeFileSync(join(root, file), buf);
      const title = String(body.title ?? '').trim() || real.replace(/\\/g, '/').split('/').pop() || '文件';
      const meta = { id, kind: sniff.kind, ext, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream', bytes: st.size, title, src: real, mtime: st.mtime.toISOString(), at: new Date().toISOString() };
      writeFileSync(metaPath(id), JSON.stringify(meta));
      return sendJson(200, { ok: true, id, url: `/api/media/${file}`, kind: sniff.kind, ext, mime: meta.mime, bytes: st.size, title });
    }

    // ---- GET /api/media/:file 直出（Range 支持视频/音频拖动） ----
    const mFile = /^\/api\/media\/([0-9a-f-]{36}\.[a-z0-9]+)$/.exec(pathname);
    if (mFile && req.method === 'GET') {
      const file = mFile[1];
      if (!FILE_RE.test(file)) { res.writeHead(400); return res.end(); }
      const p = join(root, file);
      if (!existsSync(p)) { res.writeHead(404); return res.end(); }
      const ext = file.split('.').pop();
      const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
      const size = statSync(p).size;
      // Range（音视频 seek 必需；其余类型忽略即可）
      const range = String(req.headers?.range ?? '');
      const mR = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (mR && (mR[1] || mR[2])) {
        const start = mR[1] ? parseInt(mR[1], 10) : size - parseInt(mR[2], 10);
        const end = mR[2] ? parseInt(mR[2], 10) : size - 1;
        if (start >= size || start < 0 || end >= size || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': mime, 'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
          'Cache-Control': 'private, max-age=86400', 'Content-Disposition': 'inline',
        });
        createReadStream(p, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime, 'Content-Length': String(size), 'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=86400', 'Content-Disposition': 'inline',
      });
      createReadStream(p).pipe(res);
      return;
    }

    // ---- GET /api/media/:id/meta：卡片初始化元数据 ----
    const mMeta = /^\/api\/media\/([0-9a-f-]{36})\/meta$/.exec(pathname);
    if (mMeta && req.method === 'GET') {
      const meta = readMeta(mMeta[1]);
      if (!meta) return sendJson(404, { error: 'not found', code: 'META_NOT_FOUND' });
      const out = { ok: true, ...meta };
      // 文本类：首屏预览（前 32KB）+ 总长
      if (meta.kind === 'text') {
        const p = join(root, `${meta.id}.${meta.ext}`);
        if (existsSync(p)) {
          const buf = readFileSync(p);
          out.preview = buf.subarray(0, 32 * 1024).toString('utf8');
          out.totalChars = Math.min(buf.length, 200 * 1024 * 1024);
        }
      }
      // 归档：目录树前 200 项
      if (meta.kind === 'archive') {
        const p = join(root, `${meta.id}.zip`);
        if (existsSync(p)) {
          const entries = listZipEntries(readFileSync(p));
          if (entries) { out.entries = entries.slice(0, 200); out.totalEntries = entries.length; }
        }
      }
      // sheet csv/tsv：表头 + 总行数（卡片初始化用）
      if (meta.kind === 'sheet' && (meta.ext === 'csv' || meta.ext === 'tsv')) {
        const p = join(root, `${meta.id}.${meta.ext}`);
        if (existsSync(p)) {
          const delim = meta.ext === 'tsv' ? '\t' : ',';
          const text = readFileSync(p, 'utf8');
          const { header, rows } = parseTable(text, delim);
          out.header = header;
          out.totalRows = rows.length;
        }
      }
      return sendJson(200, out);
    }

    // ---- GET /api/media/:id/table：sheet 切片（offset/limit/sort/dir/filterCol/filter） ----
    const mTable = /^\/api\/media\/([0-9a-f-]{36})\/table$/.exec(pathname);
    if (mTable && req.method === 'GET') {
      const meta = readMeta(mTable[1]);
      if (!meta) return sendJson(404, { error: 'not found', code: 'META_NOT_FOUND' });
      if (meta.kind !== 'sheet') return sendJson(400, { error: 'not a sheet', code: 'NOT_SHEET' });
      if (meta.ext !== 'csv' && meta.ext !== 'tsv') {
        return sendJson(400, { error: 'xlsx 暂不支持在线切片，请下载查看（roadmap P2）', code: 'XLSX_NYI' });
      }
      const p = join(root, `${meta.id}.${meta.ext}`);
      if (!existsSync(p)) return sendJson(404, { error: 'file missing', code: 'FILE_MISSING' });
      const delim = meta.ext === 'tsv' ? '\t' : ',';
      const { header, rows } = parseTable(readFileSync(p, 'utf8'), delim);
      let data = rows;
      const filterCol = q.get('filterCol');
      const filter = q.get('filter');
      if (filterCol !== null && filter) {
        const ci = Number(filterCol);
        if (Number.isInteger(ci) && ci >= 0 && ci < header.length) {
          const kw = filter.toLowerCase();
          data = data.filter((r) => String(r[ci] ?? '').toLowerCase().includes(kw));
        }
      }
      const sort = q.get('sort');
      if (sort !== null) {
        const si = Number(sort);
        const dir = q.get('dir') === 'desc' ? -1 : 1;
        if (Number.isInteger(si) && si >= 0 && si < header.length) {
          data = [...data].sort((a, b) => {
            const va = String(a[si] ?? ''), vb = String(b[si] ?? '');
            const na = parseFloat(va), nb = parseFloat(vb);
            const cmp = (Number.isFinite(na) && Number.isFinite(nb) && /^-?[\d.]+$/.test(va.trim()) && /^-?[\d.]+$/.test(vb.trim())) ? (na - nb) : va.localeCompare(vb, 'zh-CN');
            return cmp * dir;
          });
        }
      }
      const offset = Math.max(0, parseInt(q.get('offset') ?? '0', 10) || 0);
      const limit = Math.min(500, Math.max(1, parseInt(q.get('limit') ?? '50', 10) || 50));
      const page = data.slice(offset, offset + limit);
      return sendJson(200, { ok: true, header, total: data.length, offset, limit, rows: page });
    }

    // ---- GET /api/media/:id/text：文本切片（offset/limit 字符） ----
    const mText = /^\/api\/media\/([0-9a-f-]{36})\/text$/.exec(pathname);
    if (mText && req.method === 'GET') {
      const meta = readMeta(mText[1]);
      if (!meta) return sendJson(404, { error: 'not found', code: 'META_NOT_FOUND' });
      if (meta.kind !== 'text') return sendJson(400, { error: 'not text', code: 'NOT_TEXT' });
      const p = join(root, `${meta.id}.${meta.ext}`);
      if (!existsSync(p)) return sendJson(404, { error: 'file missing', code: 'FILE_MISSING' });
      const buf = readFileSync(p);
      const offset = Math.max(0, parseInt(q.get('offset') ?? '0', 10) || 0);
      const limit = Math.min(1024 * 1024, Math.max(1, parseInt(q.get('limit') ?? String(256 * 1024), 10) || 262144));
      const chunk = buf.subarray(offset, offset + limit);
      return sendJson(200, { ok: true, total: buf.length, offset, limit, text: chunk.toString('utf8') });
    }

    return sendJson(404, { error: 'unknown media endpoint', code: 'MEDIA_NOT_FOUND' });
  };
}

/** 从源路径尾缀猜文本扩展（高亮/下载名用；嗅探结果 kind=text 时才走这里） */
function guessTextExt(real) {
  const m = /\.([a-z0-9]+)$/i.exec(real.replace(/\\/g, '/'));
  const e = m ? m[1].toLowerCase() : '';
  return TEXT_EXTS.has(e) ? e : '';
}
