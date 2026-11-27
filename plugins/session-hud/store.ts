/**
 * session-hud 内部状态：会话标题 + 当前轮次的改动文件 / TODO 摘要。
 *
 * 数据来源全部是事件旁听（零 chat-lite 依赖）：
 * - 'session.title:changed'（chat-lite 广播）：当前会话 id/标题/首条消息；
 * - 'cap.ai.chat.runner:event'（流式事件）：tool.card / tool.result 提取
 *   文件改动（file 工具名 + 路径参数）与执行状态。
 *
 * 不持久化：HUD 是「当前会话的实时摘要」，会话切换即重置；刷新后由
 * 新一轮事件重建（历史会话的完整记录归 chat-store / ai-events 管）。
 */

export interface HudFile {
  /** 文件路径（去重键） */
  path: string;
  /** 最后一次操作：edit / write / read 等 */
  op: string;
  /** 所在工具名（files_write / files 等） */
  tool: string;
  at: number;
}

export interface HudState {
  sessionId: string | null;
  title: string | null;
  firstMessage: string | null;
  files: HudFile[];
  /** 正在执行的工具数（>0 时 HUD 显示忙碌态） */
  running: number;
}

let state: HudState = { sessionId: null, title: null, firstMessage: null, files: [], running: 0 };
const subs = new Set<() => void>();

function notify(): void {
  subs.forEach((fn) => fn());
}

export function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function getState(): HudState {
  return state;
}

/** 会话切换：清空文件清单（HUD 只跟踪当前会话） */
export function resetForSession(sessionId: string | null): void {
  state = { ...state, sessionId, files: [], running: 0 };
  notify();
}

export function setTitle(sessionId: string | null, title: string | null, firstMessage: string | null): void {
  if (state.sessionId !== sessionId) {
    resetForSession(sessionId);
  }
  state = { ...state, title, firstMessage };
  notify();
}

const FILE_TOOL_RE = /^(agent-)?files?$|files?[-_]?write|files?[-_]?edit|write[-_]?file|edit[-_]?file/i;

/** 从工具调用里提取涉及的文件路径（args 里第一个像路径的字符串字段） */
function extractPath(args: Record<string, unknown>): string | null {
  // 常见参数名优先（files_write / agent-files 契约里都是 path/file_path）
  for (const key of ['path', 'file_path', 'filePath', 'file', 'target']) {
    const v = args[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  // 兜底：第一个带路径分隔符或扩展名的字符串值
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && /[\\/][\w.-]+|\.\w{1,5}$/.test(v)) return v;
  }
  return null;
}

function isFileTool(name: string): boolean {
  return FILE_TOOL_RE.test(name) || /file/i.test(name);
}

/** 工具卡片出现：登记文件路径 + 计数运行中 */
export function noteToolCard(name: string, args: Record<string, unknown>): void {
  if (!isFileTool(name)) return;
  const path = extractPath(args);
  if (!path) return;
  const files = [...state.files];
  const idx = files.findIndex((f) => f.path === path);
  const entry: HudFile = { path, op: opOf(name), tool: name, at: Date.now() };
  if (idx >= 0) files[idx] = entry;
  else files.push(entry);
  state = { ...state, files: files.slice(-24) }; // HUD 只留最近 24 个：够看，不失控
  notify();
}

/** 工具结果返回：仅用于减运行计数（成功/失败都算结束） */
export function noteToolResult(): void {
  state = { ...state, running: Math.max(0, state.running - 1) };
  notify();
}

export function noteToolStart(): void {
  state = { ...state, running: state.running + 1 };
  notify();
}

function opOf(tool: string): string {
  if (/edit|patch/i.test(tool)) return 'edit';
  if (/write/i.test(tool)) return 'write';
  if (/read|view|list/i.test(tool)) return 'read';
  return 'tool';
}

/** 显示口径：'新会话' 未命名时取首条消息前 18 字（对齐 SessionSidebar.displayTitle） */
export function displayTitle(s: HudState): string {
  if (s.title && s.title !== '新会话') return s.title;
  if (s.firstMessage) return s.firstMessage.replace(/\s+/g, ' ').trim().slice(0, 18);
  return s.title ?? 'Polaris Lite';
}
