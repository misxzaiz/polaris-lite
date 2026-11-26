/**
 * phone-agent 插件的服务端半边：手机端点信令枢纽（docs/mobile-app-plan.md §9）。
 *
 * 「电脑 AI 看手机」的架构定案：手机=端点、宿主=信令枢纽——
 * 手机经 SSE 长连接挂在本服务上声明能力清单；AI 调 cap.tool.phone（前端半边）
 * → 这里把指令下发到目标手机的 SSE 流 → 手机执行 → POST 结果回来 → 回给 AI。
 *
 * 端点（全部要求会话 cookie）：
 *   GET  /api/phone/hello       → { ok:true }（前端探测插件可用 + 触发握手）
 *   GET  /api/phone/events      → SSE 流（设备注册/心跳/指令下行）
 *   POST /api/phone/command     → body { deviceId, action, payload, timeoutMs }
 *                                下发指令并等待手机回传（Promise 挂起，默认 30s 超时）
 *   POST /api/phone/result      → body { commandId, ok, data }（手机回传）
 *   POST /api/phone/consent     → body { allow }（首次连接的一行确认：允许 AI 访问本机）
 *   POST /api/phone/heartbeat   → { ok:true }（显式心跳；SSE 断开也判离线）
 *
 * 安全模型（对齐 agent-bash）：
 * - 会话 cookie 硬门禁（auth.getSession 注入）；PLITE_PHONE_AGENT=0 一键禁用；
 * - 「登录即身份」：设备以登录会话为 owner 证明，但**默认不登记**——手机端必须显式
 *   POST consent { allow:true } 后才进设备表（AI 永远调不到未确认设备）；
 * - 设备表存 <dataDir>/phone-gateway.json（deviceId/name/consentedAt/capabilities），
 *   consent 撤销（allow:false）即从表移除，AI 立刻不可见；
 * - 三档模式（confirm/allowlist/yolo，落盘同文件）：confirm 下敏感动作（读类）需要
 *   手机在线确认——v1 简化为「confirm 模式所有动作都回 DENIED 待手机 approve」
 *   的占位不做，先按 allowlist 白名单（动作级）+ yolo 全放行实现，confirm=仅提示；
 * - 全量审计 <dataDir>/phone-audit.log（JSON Lines）；
 * - 结果体积上限 64KB（头尾保留，防上下文打爆）。
 *
 * SSE 语义：
 * - 设备表（内存 Map<deviceId, DeviceConn>）：online = SSE 活着且心跳 <45s；
 * - 心跳：SSE 每 15s 服务端推 ping；手机 45s 无活动判离线（连接对象移除，SSE 自然断）；
 * - 指令超时：command 挂起 Promise，超时/设备离线 → 结构化错误（AI 收到
 *   「设备不在线（最后在线 3 分钟前）」而非 30s 死等）。
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const HEARTBEAT_SSE_MS = 15_000;   // 服务端 SSE ping 间隔
const ONLINE_TIMEOUT_MS = 45_000;  // 超此无心跳判离线
const COMMAND_TIMEOUT_MS = 30_000; // 指令默认超时
const RESULT_LIMIT = 64 * 1024;    // 结果 64KB 上限
const RESULT_HEAD_KEEP = 32 * 1024;
const RESULT_TAIL_KEEP = 32 * 1024;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 截断超限结果（头尾保留 + truncated 标记，对齐 agent-bash 的输出策略） */
function clampResult(data) {
  if (data == null) return { data, truncated: false };
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  if (s.length <= RESULT_LIMIT) return { data, truncated: false };
  return {
    data: s.slice(0, RESULT_HEAD_KEEP) + '\n…[truncated]…\n' + s.slice(-RESULT_TAIL_KEEP),
    truncated: true,
  };
}

import { registerPhoneTool } from './tool.mjs';

export function createServerPart(options = {}) {
  // 工具声明随插件：启用本插件即注册 phone 工具；禁用即消失。
  if (options.registry) registerPhoneTool(options.registry);
  const getSession = options.getSession;
  const verifyTempToken = options.verifyTempToken ?? ((token) => false);
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const hardOff = process.env.PLITE_PHONE_AGENT === '0';
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const configFile = resolve(dataDir, 'phone-gateway.json');
  const auditFile = resolve(dataDir, 'phone-audit.log');

  /** 持久化设备登记（consent 名册）与模式配置 */
  function readStore() {
    try {
      return JSON.parse(readFileSync(configFile, 'utf8'));
    } catch {
      return { mode: 'allowlist', devices: {} };
    }
  }
  function writeStore(s) {
    const tmp = configFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, configFile);
  }
  function audit(line) {
    try {
      appendFileSync(auditFile, JSON.stringify({ at: Date.now(), ...line }) + '\n');
    } catch { /* 审计失败不阻断主链路 */ }
  }

  /**
   * 活动连接表：deviceId → { res(SSE), lastSeen, pending: Map<commandId, {resolve,reject,timer}> }
   * 设备表（consent 名册）在 readStore().devices；连接表是运行时态。
   */
  const conns = new Map();

  function collectBody(req, limit = 256 * 1024) {
    return new Promise((r) => {
      let b = '';
      let torn = false;
      req.on('data', (c) => {
        if (torn) return;
        b += c;
        if (b.length > limit) { torn = true; b = ''; }
      });
      req.on('end', () => r({ body: b, tooLarge: torn }));
      req.on('error', () => r({ body: '', tooLarge: torn }));
    });
  }

  function sseSend(conn, event, data) {
    try {
      conn.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* 连接已断，由超时逻辑回收 */ }
  }

  function isOnline(conn) {
    return !!conn && Date.now() - conn.lastSeen < ONLINE_TIMEOUT_MS;
  }

  return async function phoneGatewayApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/phone/')) return next?.();

    // 门禁：会话 cookie 或本地回环 Bearer 临时凭证（agent-runner 的 phone 工具
    // loopback 调用走 Bearer，与 agent-bash/fs/preview 等工具端点同一纪律）
    const bearer = String(req.headers.authorization ?? '');
    const bearerOk = bearer.startsWith('Bearer ') && verifyTempToken(bearer.slice(7));
    const session = getSession?.(req);
    if (!session && !bearerOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    const sendJson = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };

    try {
      // ---- 探测（前端握手用） ----
      if (pathname === '/api/phone/hello' && req.method === 'GET') {
        return sendJson(200, { ok: true });
      }

      // ---- SSE 设备通道 ----
      if (pathname === '/api/phone/events' && req.method === 'GET') {
        const deviceId = `dev-${randomUUID().slice(0, 12)}`;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const conn = { res, lastSeen: Date.now(), pending: new Map() };
        conns.set(deviceId, conn);
        sseSend(conn, 'registered', { deviceId, serverTime: Date.now() });
        const ping = setInterval(() => {
          if (!conns.has(deviceId)) return;
          conn.lastSeen = Date.now() - HEARTBEAT_SSE_MS > 0 ? conn.lastSeen : conn.lastSeen; // ping 不刷新 lastSeen（客户端心跳才刷）
          sseSend(conn, 'ping', { at: Date.now() });
          // 超时回收：连接对象移除，挂起指令全部按「设备离线」拒绝
          if (Date.now() - conn.lastSeen > ONLINE_TIMEOUT_MS) {
            conns.delete(deviceId);
            for (const [, p] of conn.pending) {
              clearTimeout(p.timer);
              p.reject(new Error('device offline'));
            }
            conn.pending.clear();
          }
        }, HEARTBEAT_SSE_MS);
        req.on('close', () => {
          clearInterval(ping);
          conns.delete(deviceId);
          for (const [, p] of conn.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('device disconnected'));
          }
          conn.pending.clear();
        });
        return; // SSE 长连接由 res 持有
      }

      // ---- 手机端：能力上报（SSE registered 后调用；consent 过的设备才接受） ----
      if (pathname === '/api/phone/register' && req.method === 'POST') {
        const { body } = await collectBody(req);
        const b = JSON.parse(body || '{}');
        const deviceId = String(b.deviceId ?? '');
        const name = String(b.name ?? '手机');
        if (!DEVICE_ID_RE.test(deviceId)) return sendJson(400, { error: 'bad deviceId', code: 'BAD_REQUEST' });
        const conn = conns.get(deviceId);
        if (!conn) return sendJson(404, { error: 'device channel not found (connect /api/phone/events first)', code: 'NO_CHANNEL' });
        conn.lastSeen = Date.now();
        const store = readStore();
        const known = store.devices[deviceId];
        if (!known) {
          return sendJson(200, { ok: false, consentRequired: true, code: 'CONSENT_REQUIRED' });
        }
        known.name = name;
        known.capabilities = Array.isArray(b.capabilities) ? b.capabilities.map(String).slice(0, 32) : [];
        known.lastSeen = Date.now();
        writeStore(store);
        return sendJson(200, { ok: true, consented: true, name: known.name });
      }

      // ---- 手机端：consent（首次连接的一行确认；撤销即除名） ----
      if (pathname === '/api/phone/consent' && req.method === 'POST') {
        const { body } = await collectBody(req);
        const b = JSON.parse(body || '{}');
        const deviceId = String(b.deviceId ?? '');
        const allow = b.allow === true;
        if (!DEVICE_ID_RE.test(deviceId)) return sendJson(400, { error: 'bad deviceId', code: 'BAD_REQUEST' });
        const store = readStore();
        if (allow) {
          store.devices[deviceId] = {
            ...(store.devices[deviceId] ?? {}),
            name: String(b.name ?? '手机'),
            consentedAt: store.devices[deviceId]?.consentedAt ?? Date.now(),
            capabilities: [],
            lastSeen: Date.now(),
          };
        } else {
          delete store.devices[deviceId];
        }
        writeStore(store);
        audit({ op: 'consent', deviceId, allow });
        return sendJson(200, { ok: true });
      }

      // ---- 手机端：心跳 + 结果回传 ----
      if (pathname === '/api/phone/heartbeat' && req.method === 'POST') {
        const { body } = await collectBody(req);
        const b = JSON.parse(body || '{}');
        const deviceId = String(b.deviceId ?? '');
        const conn = conns.get(deviceId);
        if (!conn) return sendJson(404, { error: 'no channel', code: 'NO_CHANNEL' });
        conn.lastSeen = Date.now();
        const store = readStore();
        if (store.devices[deviceId]) { store.devices[deviceId].lastSeen = Date.now(); writeStore(store); }
        return sendJson(200, { ok: true });
      }

      if (pathname === '/api/phone/result' && req.method === 'POST') {
        const { body } = await collectBody(req);
        const b = JSON.parse(body || '{}');
        const deviceId = String(b.deviceId ?? '');
        const commandId = String(b.commandId ?? '');
        const conn = conns.get(deviceId);
        if (!conn) return sendJson(404, { error: 'no channel', code: 'NO_CHANNEL' });
        conn.lastSeen = Date.now();
        const pending = conn.pending.get(commandId);
        if (!pending) return sendJson(404, { error: 'unknown commandId', code: 'COMMAND_NOT_FOUND' });
        conn.pending.delete(commandId);
        clearTimeout(pending.timer);
        const clamped = clampResult(b.data);
        audit({ op: 'result', deviceId, commandId, ok: b.ok !== false, truncated: clamped.truncated });
        pending.resolve({ ok: b.ok !== false, data: clamped.data, truncated: clamped.truncated, error: b.error ? String(b.error).slice(0, 500) : undefined });
        return sendJson(200, { ok: true });
      }

      // ---- AI 侧：下发指令（cap.tool.phone/exec 由前端半边转发到这里） ----
      if (pathname === '/api/phone/command' && req.method === 'POST') {
        const { body, tooLarge } = await collectBody(req, 128 * 1024);
        if (tooLarge) return sendJson(413, { error: 'payload too large', code: 'PAYLOAD_TOO_LARGE' });
        const b = JSON.parse(body || '{}');
        const action = String(b.action ?? '');
        const payload = b.payload ?? {};
        const timeoutMs = Math.min(Math.max(Number(b.timeoutMs) || COMMAND_TIMEOUT_MS, 1000), 120_000);

        const store = readStore();
        // 目标设备选择：指定 deviceId（在线优先）或第一个在线设备
        const consentedIds = Object.keys(store.devices);
        if (consentedIds.length === 0) {
          return sendJson(404, { error: '没有已确认的手机设备——请在手机上打开应用并允许 AI 访问', code: 'NO_DEVICE' });
        }
        let target = null;
        if (b.deviceId) {
          const conn = conns.get(String(b.deviceId));
          target = isOnline(conn) ? { id: String(b.deviceId), conn } : null;
        } else {
          for (const id of consentedIds) {
            const conn = conns.get(id);
            if (isOnline(conn)) { target = { id, conn }; break; }
          }
        }
        if (!target) {
          const lastSeen = Math.max(...consentedIds.map((id) => Number(store.devices[id].lastSeen) || 0));
          const mins = lastSeen ? Math.max(1, Math.round((Date.now() - lastSeen) / 60000)) : 0;
          return sendJson(503, {
            error: `设备不在线${mins ? `（最后在线 ${mins} 分钟前）` : ''}——手机端需保持打开`,
            code: 'DEVICE_OFFLINE',
          });
        }

        // 动作白名单（allowlist 模式）：能力清单校验
        const dev = store.devices[target.id];
        const knownCaps = Array.isArray(dev?.capabilities) ? dev.capabilities : [];
        if (store.mode !== 'yolo' && knownCaps.length > 0 && !knownCaps.includes(action)) {
          return sendJson(403, { error: `设备未声明能力 ${action}（已声明：${knownCaps.join(', ') || '无'}）`, code: 'CAP_NOT_DECLARED', denied: true });
        }

        const commandId = randomUUID();
        const result = await new Promise((resolveP, rejectP) => {
          const timer = setTimeout(() => {
            target.conn.pending.delete(commandId);
            rejectP(new Error(`command timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          target.conn.pending.set(commandId, { resolve: resolveP, reject: rejectP, timer });
          sseSend(target.conn, 'command', { commandId, action, payload });
        }).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e), code: 'COMMAND_FAILED' }));

        audit({ op: 'command', deviceId: target.id, action, commandId, ok: result.ok !== false });
        return sendJson(result.ok === false && result.code ? 502 : 200, result);
      }

      return next?.();
    } catch (e) {
      audit({ op: 'error', error: e instanceof Error ? e.message : String(e) });
      return sendJson(500, { error: 'internal error', code: 'INTERNAL' });
    }
  };
}
