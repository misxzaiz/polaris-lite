/**
 * html-preview 插件的服务端半边（/api/preview/*）：AI 生成 HTML 交互面板的落盘与读取。
 *
 * 这是「插件双入口」的服务端那一半：UI 半边在浏览器（index.ts 注册 cap.tool.render，
 * Panel.tsx 应用架），本文件提供 Node 侧实现，由 plugins/server-registry.mjs 登记、
 * server/host.mjs 统一装配。宿主不认识 /api/preview/* 的任何语义。
 *
 * 安全模型（spec: docs/html-preview-plan.md §4，双层硬边界）：
 * - 第一道：入库静态扫描（stripComments 后跑 BLOCK_RULES，拦联网/逃逸写法）。
 *   如实声明：可被字符串拼接绕过——它只拦「AI 无恶意但习惯性 fetch/CDN 外链」的主流场景；
 * - 第二道（硬边界）：raw 端点响应头 `Content-Security-Policy: sandbox allow-scripts ...`
 *   ——iframe 加载与用户直接开 URL（顶层导航）都落入沙箱 origin（opaque：
 *   无 cookie、无同源存储、无宿主 API 资格）。原版 interactive-component 只有
 *   iframe sandbox 属性，直接开 URL 时跑真实 origin，是本版修掉的洞；
 * - 写入面锁死：只有 /render 落 <dataDir>/previews/<uuid>/，配额淘汰，无任意路径接口；
 * - previewId 服务端生成（uuid），请求侧只认 uuid 正则——天然防路径穿越；
 * - 会话 cookie 硬门禁；PLITE_PREVIEW=0 一键禁用（对齐 file-browser 的 PLITE_FS）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PREVIEW_LIMIT = 200;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
/** CSP sandbox 令牌：与 iframe sandbox 属性同档（无 allow-same-origin → opaque origin） */
const CSP_SANDBOX = 'sandbox allow-scripts allow-forms allow-pointer-lock';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 入库闸（第一道）：stripComments 后拦联网与逃逸写法。
 * 注释剥离让「注释/文档里提到 fetch」不误伤（原版裸扫全文的缺陷）。
 */
const BLOCK_RULES = [
  { re: /\bfetch\s*\(/, hint: '禁止 fetch()' },
  { re: /\bXMLHttpRequest\b/, hint: '禁止 XMLHttpRequest' },
  { re: /\bWebSocket\b/, hint: '禁止 WebSocket' },
  { re: /\bEventSource\b/, hint: '禁止 EventSource' },
  { re: /\bnavigator\.sendBeacon\b/, hint: '禁止 sendBeacon' },
  { re: /\bserviceWorker\b/, hint: '禁止 serviceWorker' },
  { re: /\bimport\s*\(/, hint: '禁止动态 import()' },
  { re: /\bwindow\.open\s*\(/, hint: '禁止 window.open' },
  { re: /\btop\.location\b|\bparent\.location\b/, hint: '禁止顶层导航' },
  { re: /\bdocument\.domain\b/, hint: '禁止 document.domain' },
  { re: /<script[^>]*\bsrc\s*=\s*(['"])(?!data:)/i, hint: '禁止外链 <script src>（不联网；库请内联）' },
];

/** 剥离 JS 注释再扫描：说明文字里提到领域词属正常文档，不算越界实现 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function scanHtml(html) {
  const stripped = stripComments(html);
  const blocked = BLOCK_RULES.filter((r) => r.re.test(stripped)).map((r) => r.hint);
  if (blocked.length) {
    throw new Error(`HTML 静态扫描未通过：${blocked.join('；')}。请改为纯本地实现（无外网请求、无顶层导航）。`);
  }
}

export function createServerPart(options = {}) {
  const getSession = options.getSession;
  const verifyTempToken = options.verifyTempToken ?? ((token) => false);
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const root = resolve(dataDir, 'previews');
  const hardOff = process.env.PLITE_PREVIEW === '0';

  /** 目录名一律 uuid（服务端生成）；请求侧 id 只认 uuid 正则，拼路径前校验 */
  function previewDir(id) {
    if (!UUID_RE.test(id)) throw new Error('previewId 不合法');
    return join(root, id);
  }

  function readMetadata(id) {
    try {
      return JSON.parse(readFileSync(join(previewDir(id), 'metadata.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /** 配额：超限按目录 mtime 淘汰最旧（自动老化，无需管理界面） */
  function enforceQuota() {
    let dirs = [];
    try {
      dirs = readdirSync(root).filter((n) => UUID_RE.test(n));
    } catch {
      return;
    }
    if (dirs.length <= PREVIEW_LIMIT) return;
    const stamped = dirs
      .map((n) => {
        try { return { n, m: statSync(join(root, n)).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean);
    stamped.sort((a, b) => a.m - b.m);
    const excess = stamped.length - PREVIEW_LIMIT;
    for (const { n } of stamped.slice(0, Math.max(0, excess))) {
      try { rmSync(join(root, n), { recursive: true, force: true }); } catch { /* 并发淘汰竞争：下轮再收 */ }
    }
  }

  return async function previewApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/preview/')) return next?.();

    // 登录门禁：会话 cookie 或本地回环 Bearer（auth-session 临时凭证；agent-runner
    // 服务端编排 loopback 调用走 Bearer，与 agent-bash/fs 同一纪律）二选一。
    const authHeader = String(req.headers?.authorization ?? '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const bearerValid = !!(bearerToken && verifyTempToken(bearerToken));
    const session = getSession?.(req);
    if (!session && !bearerValid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    const readBody = () => new Promise((r) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 8 * 1024 * 1024) req.destroy(); });
      req.on('end', () => r(b));
    });
    const sendJson = (code, obj, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(obj));
    };

    try {
      // ---- POST /api/preview/render：扫描 → 落盘 → 引用返回（不回 HTML） ----
      if (pathname === '/api/preview/render') {
        if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
        const body = JSON.parse((await readBody()) || '{}');
        const html = typeof body.html === 'string' ? body.html : '';
        if (!html.trim()) return sendJson(400, { error: '缺少 html' });
        const bytes = Buffer.byteLength(html, 'utf8');
        if (bytes > MAX_HTML_BYTES) {
          return sendJson(400, { error: `HTML 过大（${bytes} bytes > ${MAX_HTML_BYTES}），请精简` });
        }
        try {
          scanHtml(html);
        } catch (e) {
          return sendJson(400, { error: e.message });
        }
        const title = (typeof body.title === 'string' && body.title.trim()) ? body.title.trim().slice(0, 120) : '交互面板';
        // 版本归组：basePreviewId 有效时与其同组递增，否则新组 v1
        let baseVersion = 0;
        let baseId = null;
        if (typeof body.basePreviewId === 'string' && UUID_RE.test(body.basePreviewId)) {
          const meta = readMetadata(body.basePreviewId);
          if (meta) {
            baseVersion = Number(meta.version) || 0;
            baseId = meta.basePreviewId ?? body.basePreviewId; // 归组追溯到组首
          }
        }
        const previewId = randomUUID();
        const dir = previewDir(previewId);
        mkdirSync(dir, { recursive: true });
        const metadata = {
          previewId,
          basePreviewId: baseId,
          title,
          version: baseVersion + 1,
          versionLabel: `v${baseVersion + 1}`,
          bytes,
          createdAt: new Date().toISOString(),
        };
        writeFileSync(join(dir, 'index.html'), html, 'utf8');
        writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
        enforceQuota();
        return sendJson(200, { ...metadata, url: `/api/preview/${previewId}/raw` });
      }

      // ---- GET /api/preview/list：落盘目录实读（面板持久化数据源） ----
      if (pathname === '/api/preview/list') {
        if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
        let limit = 50;
        const q = new URL(req.url, 'http://x').searchParams.get('limit');
        if (q) limit = Math.min(200, Math.max(1, Number(q) || 50));
        let dirs = [];
        try { dirs = readdirSync(root).filter((n) => UUID_RE.test(n)); } catch { /* 尚无目录 */ }
        const items = dirs
          .map((n) => readMetadata(n))
          .filter(Boolean)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, limit);
        return sendJson(200, { previews: items, total: dirs.length });
      }

      // ---- GET /api/preview/:id/raw | /meta ----
      const m = pathname.match(/^\/api\/preview\/([^/]+)\/(raw|meta)$/);
      if (m) {
        if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
        const id = m[1];
        let dir;
        try { dir = previewDir(id); } catch { return sendJson(400, { error: 'previewId 不合法' }); }
        const idx = join(dir, 'index.html');
        if (!existsSync(idx)) return sendJson(404, { error: '预览不存在' });
        if (m[2] === 'meta') {
          const meta = readMetadata(id) ?? {};
          const html = readFileSync(idx, 'utf8');
          return sendJson(200, { ...meta, html, url: `/api/preview/${id}/raw` });
        }
        // raw：CSP sandbox 头是硬边界（iframe 与顶层导航都落入沙箱 origin）
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': CSP_SANDBOX,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        });
        return res.end(readFileSync(idx, 'utf8'));
      }

      return next?.();
    } catch (e) {
      return sendJson(500, { error: e?.message || 'preview api error' });
    }
  };
}
