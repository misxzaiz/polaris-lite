/**
 * image-push 插件的服务端半边：AI 把电脑上的图片文件推送到对话给用户看。
 *
 * 形态（对齐 html-preview 的「工具只传引用，内容不过模型」纪律）：
 *   POST /api/img/push   { path, cwd?, title?, sessionId? } → { ok, id, url, bytes, mime, title }
 *                        服务端读文件 + 魔数嗅探 + 拷贝落盘；模型侧只见路径与 URL 引用。
 *   GET  /api/img/:file  图片直出（Content-Type 按落盘扩展名；cookie/本地 Bearer 门禁；
 *                        uuid 命名防穿越；手机同源 <img> 自动带 cookie）。
 *
 * 落盘：<dataDir>/image-push/<uuid>.<嗅探扩展名>。
 *
 * 设计要点：
 * - 魔数嗅探不信任扩展名：ego-browser 截图 .jpg 实为 WebP（RIFF），扩展名说谎是常态；
 *   落盘扩展名一律改写为嗅探结果，GET 侧只认白名单扩展名。
 * - 拒绝非图片：文本/视频等直接报错给模型（工具反馈可读）。
 * - 尺寸闸：>25MB 拒绝（手机加载与 runner 参数闸共同防大内容过模型）。
 * - 无 TTL/GC：截图类图片体量小（百 KB 级），与 previews/ 同策略常驻数据目录。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerPushImageTool } from './tool.mjs';

/** 单张图片上限：手机网络加载体感与磁盘占用的平衡点 */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** 落盘文件名白名单（uuid + 嗅探扩展名；请求侧拼路径前校验，天然防穿越） */
const FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|avif)$/;

/** 魔数 → { ext, mime }。扩展名只是线索，内容说了算。 */
function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (buf.length >= 6 && (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a')) {
    return { ext: 'gif', mime: 'image/gif' };
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { ext: 'bmp', mime: 'image/bmp' };
  }
  // ISOBMFF ftyp box：只放行 avif/heic 图像品牌（mp4 等视频品牌拒绝）
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (/^(avif|avis|heic|heix|mif1)/.test(brand)) return { ext: 'avif', mime: 'image/avif' };
  }
  return null;
}

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
};

export function createServerPart(options = {}) {
  if (options.registry) registerPushImageTool(options.registry);
  const getSession = options.getSession;
  const verifyTempToken = options.verifyTempToken ?? (() => false);
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const root = resolve(dataDir, 'image-push');

  return async function imagePushApi(req, res, next) {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/img/')) return next?.();

    // 登录门禁：会话 cookie 或本地回环 Bearer（与 html-preview/browser-lite 同一纪律；
    // agent-runner 服务端编排 loopback 调用走 Bearer，手机浏览器同源 <img> 带 cookie）
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

    // ---- POST /api/img/push：读文件 → 嗅探 → 落盘（工具 loopback 入口） ----
    if (pathname === '/api/img/push' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody()) || '{}'); } catch { return sendJson(400, { error: 'bad json', code: 'BAD_REQUEST' }); }
      const rawPath = String(body.path ?? '').trim();
      if (!rawPath) return sendJson(400, { error: '缺少 path（图片文件的本地路径）', code: 'PATH_REQUIRED' });
      // 相对路径按调用方 cwd 解析（工具侧传 run.execCwd）；node:* import 仅 server.mjs 豁免，解析在服务端做
      const cwd = String(body.cwd ?? '') || process.cwd();
      const real = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
      let st;
      try { st = statSync(real); } catch { return sendJson(400, { error: `文件不存在或不可读：${real}`, code: 'NOT_FOUND' }); }
      if (!st.isFile()) return sendJson(400, { error: '不是常规文件', code: 'NOT_FILE' });
      if (st.size > MAX_IMAGE_BYTES) {
        return sendJson(400, { error: `图片过大（${Math.round(st.size / 1024 / 1024)}MB > ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB），请先压缩或裁剪`, code: 'TOO_LARGE' });
      }
      let buf;
      try { buf = readFileSync(real); } catch (e) { return sendJson(400, { error: `读取失败：${e.message}`, code: 'READ_FAILED' }); }
      const kind = sniffImage(buf);
      if (!kind) return sendJson(400, { error: '不是可识别的图片格式（PNG/JPEG/WebP/GIF/BMP/AVIF）。屏幕录制请转 mp4 之外的图片格式，或分帧截图。', code: 'NOT_IMAGE' });
      mkdirSync(root, { recursive: true });
      const id = randomUUID();
      const file = `${id}.${kind.ext}`;
      writeFileSync(join(root, file), buf);
      const title = String(body.title ?? '').trim() || real.replace(/\\/g, '/').split('/').pop() || '图片';
      return sendJson(200, { ok: true, id, url: `/api/img/${file}`, bytes: st.size, mime: kind.mime, title });
    }

    // ---- GET /api/img/:file：图片直出（对话/查看器/手机 <img> 的数据面） ----
    const m = /^\/api\/img\/([0-9a-f-]+\.(?:png|jpg|webp|gif|bmp|avif))$/.exec(pathname);
    if (m && req.method === 'GET') {
      const file = m[1];
      if (!FILE_RE.test(file)) { res.writeHead(400); return res.end(); }
      const p = join(root, file);
      if (!existsSync(p)) { res.writeHead(404); return res.end(); }
      const ext = file.split('.').pop();
      res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=86400', 'Content-Disposition': 'inline' });
      createReadStream(p).pipe(res);
      return;
    }

    return sendJson(404, { error: 'unknown img endpoint', code: 'IMG_NOT_FOUND' });
  };
}
