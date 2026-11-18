/** 极简 HTTP 工具：请求体读取（带上限）、JSON 响应、统一错误类型。 */

export const BODY_LIMIT_SMALL = 64 * 1024;   // 认证/表单类
export const BODY_LIMIT_LARGE = 5 * 1024 * 1024; // 模型请求（含图片 base64）

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

/**
 * 读取请求体并解析 JSON。
 * - 超限立刻 413 并断开（不让内存被无界请求吃掉）；
 * - 畸形 JSON 抛 400 而不是让 async 中间件崩在半路（原实现会挂死请求）。
 */
export function readJson(req, limit = BODY_LIMIT_SMALL) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const onData = (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new HttpError(413, 'BODY_TOO_LARGE', `请求体超过 ${limit} 字节`));
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new HttpError(400, 'BAD_JSON', '请求体必须是 JSON 对象'));
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'BAD_JSON', 'JSON 解析失败'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'REQUEST_ERROR', '请求读取失败')));
  });
}

/** 同一请求只允许响应一次（防二次 writeHead 抛 ERR_HTTP_HEADERS_SENT） */
export function sendJson(res, status, obj) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 把异常统一转成 {code, message} 响应；未知异常按 500 且不外泄堆栈 */
export function sendError(res, err) {
  if (err instanceof HttpError) return sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message } });
  return sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: '服务端内部错误' } });
}
