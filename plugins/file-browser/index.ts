/**
 * file-browser 插件：文件浏览器（原型）。
 *
 * 三角色（设计见 docs/file-browser-analysis.md）：
 * 1. 人用浏览器：panel 视图（盘符条/根选择/目录网格/只读预览）；
 * 2. 工作区状态持有者：activeRoot/linkedRoots 偏好（cap.config ns=file-browser），
 *    变更广播 workspace-changed（agent-loop/agent-bash 监听联动）；
 * 3. AI 通道：cap.tool.fs（roots/list/read 只读），照 describe 协议进 agent-loop。
 *
 * 安全约定：服务端 roots 白名单 + realpath 防逃逸（fs-api.mjs）；本插件只做展示与
 * 选择，不做任何写操作（写走 bash 工具的审批链）。只依赖 /api/fs/* 与 @sdk。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { FileBrowserPanel, setPanelApi } from './Panel';
import './fs.css';

export interface FsRoot {
  id: string;
  path: string;
  label: string;
  builtin?: boolean;
  missing?: boolean;
}

let hostApi: SlotHostApi | null = null;

/** ---- 工作区偏好（唯一权威；经 cap.config 持久化） ---- */
const NS = 'file-browser';
let activeRootId: string | null = null;
const linkedRootIds = new Set<string>();

function loadPrefs(): void {
  if (!hostApi) return;
  void hostApi
    .dispatch<{ value?: { activeRootId?: string; linkedRootIds?: string[] } }>({
      target: 'cap.config', action: 'get', payload: { namespace: NS, key: 'prefs' },
    })
    .then((res) => {
      const v = res.ok ? res.data?.value : undefined;
      if (v?.activeRootId) activeRootId = v.activeRootId;
      if (Array.isArray(v?.linkedRootIds)) v.linkedRootIds.forEach((id) => linkedRootIds.add(id));
      if (activeRootId) emitWorkspaceChanged();
    });
}

function savePrefs(): void {
  if (!hostApi) return;
  void hostApi.dispatch({
    target: 'cap.config', action: 'set',
    payload: {
      namespace: NS, key: 'prefs',
      value: { activeRootId: activeRootId, linkedRootIds: [...linkedRootIds] },
    },
  });
}

function emitWorkspaceChanged(): void {
  hostApi?.emit('workspace-changed', { activeRootId, linkedRootIds: [...linkedRootIds] });
}

/** 供面板调用：设置当前工作区（联动广播） */
export function setActiveRoot(id: string): void {
  activeRootId = id;
  savePrefs();
  emitWorkspaceChanged();
}

/** 供面板调用：切换关联（只读上下文）根 */
export function toggleLinkedRoot(id: string): void {
  if (linkedRootIds.has(id)) linkedRootIds.delete(id);
  else linkedRootIds.add(id);
  savePrefs();
  emitWorkspaceChanged();
}

/** 工作区语义查询（agent-loop/其他插件经 cap.tool.fs/roots 获取） */
export function workspaceState(): { activeRootId: string | null; linkedRootIds: string[] } {
  return { activeRootId, linkedRootIds: [...linkedRootIds] };
}

/** ---- AI 工具能力：cap.tool.fs（describe 协议 + list/read/roots 执行） ---- */
async function fsFetch(path: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const resp = await fetch(`/api/fs/${path}`, { credentials: 'include', ...init });
  let json: any = null;
  try { json = await resp.json(); } catch { /* 非 JSON */ }
  return { status: resp.status, json };
}

function createFsHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as { rootId?: string; path?: string; head?: number; tail?: number };
    switch (req.action) {
      case 'describe':
        return {
          descriptor: {
            cap: 'cap.tool.fs',
            name: 'files',
            description:
              '浏览与读取工作区文件（只读）。动作：roots=列出工作区根与当前工作区；' +
              'list=列目录（rootId+相对路径）；read=读文本文件（可带 head/tail 行数取片段）。' +
              '路径一律相对工作区根；写入请用 bash 工具。',
            parameters: { type: 'object', properties: {} },
            danger: 'read',
          },
        };
      case 'roots': {
        const [rootsR, ws] = await Promise.all([fsFetch('roots'), Promise.resolve(workspaceState())]);
        const roots = (rootsR.json?.roots ?? []) as FsRoot[];
        return {
          roots: roots.map((r) => ({
            id: r.id, label: r.label, path: r.path, builtin: !!r.builtin,
            active: r.id === ws.activeRootId, linked: ws.linkedRootIds.includes(r.id),
          })),
          note: 'active=当前工作区（bash cwd）；linked=只读关联目录',
        };
      }
      case 'list': {
        if (!payload.rootId) return { ok: false, error: 'rootId required' };
        const q = new URLSearchParams({ rootId: payload.rootId, path: payload.path ?? '' });
        const r = await fsFetch(`list?${q}`);
        if (r.status !== 200) return { ok: false, error: r.json?.error ?? `HTTP ${r.status}` };
        return { ok: true, entries: r.json.entries, truncated: r.json.truncated };
      }
      case 'read': {
        if (!payload.rootId) return { ok: false, error: 'rootId required' };
        const q = new URLSearchParams({ rootId: payload.rootId, path: payload.path ?? '' });
        if (payload.head) q.set('head', String(payload.head));
        if (payload.tail) q.set('tail', String(payload.tail));
        const r = await fsFetch(`read?${q}`);
        if (r.status !== 200) return { ok: false, error: r.json?.error ?? `HTTP ${r.status}` };
        if (r.json.tooLarge) return { ok: false, error: r.json.hint ?? '文件过大', tooLarge: true, size: r.json.size };
        if (!r.json.isText) return { ok: false, error: '二进制文件不支持文本读取' };
        return { ok: true, text: r.json.text, size: r.json.size, truncated: r.json.truncated };
      }
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

export const fileBrowserPlugin: LitePlugin = {
  manifest: {
    id: 'file-browser',
    name: '文件',
    version: '0.1.0',
    capabilities: ['cap.config'],
    provides: ['cap.tool.fs'],
    events: ['tool-registered', 'workspace-changed'],
    contributes: {
      slots: [{ slot: 'panel', component: 'FileBrowserPanel', order: 6, title: '文件' }],
    },
  },
  setup(api: SlotHostApi) {
    hostApi = api;
    setPanelApi(api);
    api.registerCapability.register('cap.tool.fs', createFsHandler());
    api.emit('tool-registered', { cap: 'cap.tool.fs', name: 'files' });
    loadPrefs();
  },
};

export { FileBrowserPanel };

export default fileBrowserPlugin;
