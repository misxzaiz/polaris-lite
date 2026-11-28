/**
 * system-prompt 插件的服务端半边。
 *
 * 职责（2026-11-28 v0.3 升级：多套 profiles + 版本历史 + AI 工具 + 模板参数）：
 * 1. service 表（id='system-prompt'）：get(sessionId) 返回「全局激活 profile + 会话覆盖段」
 *    拼接结果，供 agent-runner 的 seedShadow 消费（追加进 system prompt）。
 * 2. registry.registerTool('system_prompt')：AI 在对话内实时查看/切换/编辑/回滚 profiles，
 *    写 kv 后下一轮对话即生效（system prompt 每轮重建，天然实时）。
 *
 * 存储复用 kv-store 的 service（id='kv-store'），namespace='system-prompt'：
 *   key='profiles'      → Array<{id, name, text, enabled, createdAt, updatedAt}>
 *   key='active'        → string（当前激活的 profile id）
 *   key='history'       → Array<{ts, profileId, name, text}>（保存前快照，保留 20 版）
 *   key='global'        → 旧版全局文本（迁移源；迁移后保留不动，兼容回滚）
 *   key=`session.<id>`   → 会话覆盖段（字符串，与旧版语义一致）
 *
 * 模板参数（expandTemplate，注入时实时展开）：
 *   {{date}} {{time}} {{weekday}} {{timeOfDay}} {{persona}} {{port}} {{envRole}}
 *   timeOfDay: 5-11 早 12-17 午 18-23 晚 0-4 深夜
 *
 * 迁移：首次读 profiles 为空且存在旧 global 文本时，自动建「默认」profile 并激活。
 */
const NS = 'system-prompt';
const HISTORY_CAP = 20;

/* ---------------- kv 薄封装（service 表内同步读写） ---------------- */

function kvService(registry) {
  return registry?.getService?.('kv-store') ?? null;
}

function readKv(kv, key) {
  const v = kv?.get?.(NS, key) ?? null;
  return v === undefined ? null : v;
}

function writeKv(kv, key, value) {
  kv?.set?.(NS, key, value);
}

/* ---------------- profiles 数据操作 ---------------- */

function normalizeProfiles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p === 'object' && typeof p.text === 'string')
    .map((p, i) => ({
      id: typeof p.id === 'string' && p.id.trim() ? p.id.trim() : `p${Date.now()}_${i}`,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `提示词 ${i + 1}`,
      text: p.text,
      enabled: p.enabled !== false,
      createdAt: Number(p.createdAt) || Date.now(),
      updatedAt: Number(p.updatedAt) || Date.now(),
    }));
}

function loadProfiles(kv) {
  const raw = readKv(kv, 'profiles');
  let profiles = normalizeProfiles(raw);
  // 旧数据迁移：无 profiles 但有旧 global 文本 → 建「默认」profile 并激活
  if (profiles.length === 0) {
    const legacy = readKv(kv, 'global');
    if (typeof legacy === 'string' && legacy.trim()) {
      const now = Date.now();
      profiles = [{
        id: 'default',
        name: '默认',
        text: legacy.trim(),
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }];
      writeKv(kv, 'profiles', profiles);
      writeKv(kv, 'active', 'default');
    }
  }
  return profiles;
}

function loadActiveId(kv, profiles) {
  const active = readKv(kv, 'active');
  if (typeof active === 'string' && profiles.some((p) => p.id === active)) return active;
  return profiles[0]?.id ?? null;
}

function pushHistory(kv, entry) {
  const hist = Array.isArray(readKv(kv, 'history')) ? readKv(kv, 'history') : [];
  hist.unshift({ ts: Date.now(), ...entry });
  writeKv(kv, 'history', hist.slice(0, HISTORY_CAP));
}

/* ---------------- 模板展开 ---------------- */

function timeOfDayOf(hour) {
  if (hour >= 5 && hour < 12) return '早';
  if (hour >= 12 && hour < 18) return '午';
  if (hour >= 18 && hour < 24) return '晚';
  return '深夜';
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 展开模板参数。context 可注入 { persona, port, envRole, now }（now 为 Date）。
 * 未知占位符原样保留（不吞用户文本）。
 */
export function expandTemplate(text, context = {}) {
  if (typeof text !== 'string' || !text.includes('{{')) return text;
  const now = context.now instanceof Date ? context.now : new Date();
  const h = now.getHours();
  const vars = {
    date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    time: `${String(h).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    weekday: `星期${WEEKDAYS[now.getDay()]}`,
    timeOfDay: timeOfDayOf(h),
    persona: typeof context.persona === 'string' ? context.persona : '',
    port: typeof context.port === 'string' ? context.port : '',
    envRole: typeof context.envRole === 'string' ? context.envRole : '',
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m));
}

/* ---------------- service + 工具共用的读取逻辑 ---------------- */

function combinedPrompt(kv, sessionId, context) {
  const profiles = loadProfiles(kv);
  if (profiles.length === 0) return null;
  const activeId = loadActiveId(kv, profiles);
  const active = profiles.find((p) => p.id === activeId) ?? null;
  const parts = [];
  if (active && active.enabled && active.text.trim()) {
    parts.push(expandTemplate(active.text, { ...context, persona: active.name }));
  }
  const session = readKv(kv, `session.${String(sessionId ?? '')}`);
  if (typeof session === 'string' && session.trim()) {
    parts.push(expandTemplate(session.trim(), { ...context, persona: active?.name }));
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/* ---------------- 工具动作 ---------------- */

function toolList(kv) {
  const profiles = loadProfiles(kv);
  const activeId = loadActiveId(kv, profiles);
  return {
    ok: true,
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, active: p.id === activeId, chars: p.text.length, updatedAt: p.updatedAt })),
  };
}

function toolSetActive(kv, profileId) {
  const profiles = loadProfiles(kv);
  const target = profiles.find((p) => p.id === profileId || p.name === profileId);
  if (!target) return { ok: false, error: `提示词不存在：${profileId}（用 list 查看全部）` };
  writeKv(kv, 'active', target.id);
  return { ok: true, message: `已激活「${target.name}」，下一轮对话生效`, profile: { id: target.id, name: target.name } };
}

function toolSetText(kv, profileId, text) {
  if (typeof text !== 'string') return { ok: false, error: 'text 必须是字符串' };
  const profiles = loadProfiles(kv);
  const target = profiles.find((p) => p.id === profileId || p.name === profileId);
  if (!target) return { ok: false, error: `提示词不存在：${profileId}` };
  pushHistory(kv, { profileId: target.id, name: target.name, text: target.text });
  target.text = text;
  target.updatedAt = Date.now();
  writeKv(kv, 'profiles', profiles);
  return { ok: true, message: `「${target.name}」文本已更新，下一轮对话生效`, profile: { id: target.id, name: target.name } };
}

function toolCreate(kv, name, text) {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, error: 'name 不能为空' };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'text 不能为空' };
  const profiles = loadProfiles(kv);
  if (profiles.some((p) => p.name === n)) return { ok: false, error: `已有同名提示词「${n}」` };
  const now = Date.now();
  const profile = { id: `p${now}`, name: n, text: text.trim(), enabled: true, createdAt: now, updatedAt: now };
  profiles.push(profile);
  writeKv(kv, 'profiles', profiles);
  return { ok: true, message: `已创建「${n}」（未激活，用 set 激活）`, profile: { id: profile.id, name: profile.name } };
}

function toolDelete(kv, profileId) {
  const profiles = loadProfiles(kv);
  const activeId = loadActiveId(kv, profiles);
  const idx = profiles.findIndex((p) => p.id === profileId || p.name === profileId);
  if (idx < 0) return { ok: false, error: `提示词不存在：${profileId}` };
  if (profiles.length <= 1) return { ok: false, error: '至少保留一套提示词（可用 set 清空文本代替删除）' };
  const [removed] = profiles.splice(idx, 1);
  if (removed.id === activeId) writeKv(kv, 'active', profiles[0].id);
  writeKv(kv, 'profiles', profiles);
  return { ok: true, message: `已删除「${removed.name}」`, active: profiles[0].id };
}

function toolHistory(kv, profileId) {
  const hist = Array.isArray(readKv(kv, 'history')) ? readKv(kv, 'history') : [];
  // 过滤条件同时接受 id 或 name（与 set/text/delete 的寻址语义一致）
  const list = profileId ? hist.filter((e) => e.profileId === profileId || e.name === profileId) : hist;
  return {
    ok: true,
    versions: list.slice(0, HISTORY_CAP).map((e, i) => ({ index: i, ts: e.ts, profileId: e.profileId, name: e.name, chars: (e.text || '').length, text: e.text })),
  };
}

function toolRestore(kv, index) {
  const hist = Array.isArray(readKv(kv, 'history')) ? readKv(kv, 'history') : [];
  const entry = hist[Number(index)];
  if (!entry) return { ok: false, error: `版本不存在：${index}（用 history 查看版本列表）` };
  const profiles = loadProfiles(kv);
  let target = profiles.find((p) => p.id === entry.profileId);
  if (!target) {
    // 原 profile 已删除：按历史快照重建
    const now = Date.now();
    target = { id: entry.profileId, name: entry.name, text: '', enabled: true, createdAt: now, updatedAt: now };
    profiles.push(target);
  }
  pushHistory(kv, { profileId: target.id, name: target.name, text: target.text }); // 回滚也可再撤销
  target.text = entry.text;
  target.updatedAt = Date.now();
  writeKv(kv, 'profiles', profiles);
  return { ok: true, message: `「${target.name}」已回滚到 ${new Date(entry.ts).toLocaleString('zh-CN')} 的版本`, profile: { id: target.id, name: target.name } };
}

function execToolAction(kv, args) {
  const action = String(args.action ?? '');
  try {
    switch (action) {
      case 'list': return toolList(kv);
      case 'set': return toolSetActive(kv, args.id ?? args.profileId);
      case 'text': return toolSetText(kv, args.id ?? args.profileId, args.text);
      case 'create': return toolCreate(kv, args.name, args.text);
      case 'delete': return toolDelete(kv, args.id ?? args.profileId);
      case 'history': return toolHistory(kv, args.id ?? args.profileId);
      case 'restore': return toolRestore(kv, args.index);
      default: return { ok: false, error: `未知 action：${action}（支持 list/set/text/create/delete/history/restore）` };
    }
  } catch (e) {
    return { ok: false, error: `执行失败：${e?.message ?? e}` };
  }
}

/* ---------------- 服务端装配 ---------------- */

export function createServerPart(options = {}) {
  const registry = options.registry;

  if (registry?.registerService && !registry.getService?.('system-prompt')) {
    registry.registerService('system-prompt', {
      /**
       * 读组合提示词（全局激活 profile + 会话覆盖段），两者皆空返回 null。
       * 拼接顺序：全局在前、会话在后。模板参数实时展开（时间类每轮新值）。
       */
      get(sessionId, context) {
        try {
          const kv = kvService(registry);
          if (!kv) return null;
          return combinedPrompt(kv, sessionId, context ?? {});
        } catch {
          return null;
        }
      },
    });
  }

  // AI 工具：system_prompt（list/set/text/create/delete/history/restore）
  if (registry?.registerTool && !registry.getService?.('__system_prompt_tool__')) {
    registry.registerTool({
      name: 'system_prompt',
      noApproval: true,
      descriptor: {
        type: 'function',
        function: {
          name: 'system_prompt',
          description: '管理自定义系统提示词（多套可选、可切换、可回滚），改动下一轮对话实时生效。action：list=列出全部（含当前激活）；set=切换激活（参数 id 或 name）；text=编辑某套文本（参数 id/name + text）；create=新建（name + text）；delete=删除（至少保留一套）；history=查版本历史（可按 id 过滤）；restore=回滚到历史版本（index，先 history 查）。文本支持模板参数：{{date}} {{time}} {{weekday}} {{timeOfDay}} {{persona}} {{port}} {{envRole}}。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['list', 'set', 'text', 'create', 'delete', 'history', 'restore'] },
              id: { type: 'string', description: '目标提示词的 id 或 name（set/text/delete/history 用）' },
              name: { type: 'string', description: '新建时的名称（create 用）' },
              text: { type: 'string', description: '提示词正文（text/create 用），支持模板参数' },
              index: { type: 'number', description: '版本序号（restore 用，先 history 查）' },
            },
            required: ['action'],
          },
        },
      },
      invoke: async ({ args }) => {
        const kv = kvService(registry);
        if (!kv) return { ok: false, stdout: '', stderr: '提示词服务不可用（kv-store 未装配）' };
        const r = execToolAction(kv, args ?? {});
        return { ok: !!r.ok, stdout: JSON.stringify(r).slice(0, 8 * 1024), stderr: r.ok ? '' : (r.error ?? '执行失败') };
      },
    });
  }

  return function systemPromptServer(_req, _res, next) {
    return next?.();
  };
}
