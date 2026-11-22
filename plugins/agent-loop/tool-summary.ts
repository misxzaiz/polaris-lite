/**
 * 工具调用摘要（tool.card / tool.result / 审批卡三处共用的单行摘要 + 审批前缀键）。
 *
 * 背景（2026-11-21 用户反馈「不知道 AI 操作了什么」）：此前 tool.card 的 command 只取
 * `parsed.command`（仅 bash 有该参数），browser/ledger/files/MCP 等语义工具的参数是
 * {action,...} 形状 → command 恒为空串 → 卡片摘要只剩状态「完成」。本模块按工具家族
 * 生成人类可读的单行摘要（browser 附加动作细节：URL/元素文本/按键/滚动量等）。
 *
 * 两个出口的语义约定：
 * - `display`：给人看的摘要（≤120 字符截断），进 tool.card / tool.result 的 command 字段
 *   与审批卡命令区；
 * - `approvalKey`：「总是允许该前缀」白名单的匹配键，必须跨调用稳定——
 *   bash 保持原始命令（历史语义零变化）；browser 锚定到 `browser <action>` 动作级
 *   （与旧 tool.result 前缀一致，URL 变化不重复弹审批）；MCP 锚定到完整工具名；
 *   其余动作语义工具锚定到 `<name> <action>`。审批卡展示仍用 display（用户要看到细节再决策）。
 */

export interface ToolCallSummary {
  display: string;
  approvalKey: string;
}

/** display 上限（卡片单行摘要经 oneLine 还会再截 48，这里是存储层上限） */
const DISPLAY_CAP = 120;

function capStr(s: string, max = DISPLAY_CAP): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 宽松解析参数 JSON：非法/非对象一律回空表（摘要降级为工具名，不抛错） */
function parseArgs(raw: string): Record<string, unknown> {
  try {
    const p = JSON.parse(raw || '{}') as unknown;
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** browser 各动作的细节段（「browser <action>」之后的部分；缺细节返回空串） */
function browserDetail(a: Record<string, unknown>): string {
  const action = str(a.action);
  const q = (v: unknown): string => `"${str(v).replace(/\s+/g, ' ').trim()}"`;
  switch (action) {
    case 'acquire':
    case 'read':
      return str(a.url) ? ` ${str(a.url)}` : '';
    case 'navigate':
      return str(a.url) ? ` → ${str(a.url)}` : '';
    case 'search': {
      const engine = str(a.engine);
      return str(a.query) ? ` ${q(a.query)}${engine ? ` @${engine}` : ''}` : '';
    }
    case 'click': {
      if (str(a.label)) return ` ${q(a.label)}`;
      if (str(a.selector)) return ` [${str(a.selector)}]`;
      if (a.index !== undefined) return ` #${str(a.index)}`;
      return '';
    }
    case 'fill': {
      const at = str(a.label) ? q(a.label) : str(a.selector) ? `[${str(a.selector)}]` : '';
      const value = str(a.value);
      const vShort = value.length > 40 ? `${value.slice(0, 40)}…` : value;
      return at ? ` ${at} ← ${q(vShort)}` : '';
    }
    case 'press_key':
      return str(a.keys) ? ` ${str(a.keys)}` : '';
    case 'scroll': {
      const amount = a.amount !== undefined ? Number(a.amount) || 600 : 600;
      const arrow = str(a.direction) === 'up' ? '↑' : '↓';
      return ` ${arrow}${amount}`;
    }
    case 'find': {
      const t = str(a.query) || str(a.label) || str(a.selector);
      return t ? ` ${q(t)}` : '';
    }
    case 'screenshot':
      return a.fullPage === true ? ' (整页)' : '';
    case 'wait': {
      if (str(a.selector_wait)) return ` selector ${str(a.selector_wait)}`;
      if (str(a.urlPattern)) return ` url ~${str(a.urlPattern)}`;
      if (a.downloadComplete === true) return ' 下载完成';
      return '';
    }
    case 'close':
      return a.closeAll === true ? ' (全部标签)' : '';
    case 'history': {
      const h = str(a.historyAction) || 'list';
      return h === 'list' ? '' : ` ${h}`;
    }
    default:
      return '';
  }
}

/** MCP 工具名去 `mcp__<server>__` 前缀（display 更短；approvalKey 仍用全名保证稳定） */
function mcpShortName(name: string): string {
  const parts = name.split('__');
  return parts.length >= 3 ? parts.slice(2).join('__') : name;
}

/** 兜底摘要：工具名 + 最多 2 个原始类型参数的 k=v 预览（browser 之外未识别的语义工具） */
function genericDetail(a: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    if (pairs.length >= 2) break;
    if (k === 'action') continue; // 动作已在摘要主干里，重复展示是噪音
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') continue;
    const vs = String(v);
    pairs.push(`${k}=${vs.length > 24 ? `${vs.slice(0, 24)}…` : vs}`);
  }
  return pairs.length ? ` (${pairs.join(', ')})` : '';
}

/**
 * 摘要入口：name=工具名（模型 tool_call.name），argsJson=模型给的原始参数 JSON。
 * 任何输入都不抛错：非法 JSON / 空参数降级为工具名。
 */
export function summarizeToolCall(name: string, argsJson: string): ToolCallSummary {
  const a = parseArgs(argsJson);
  const action = str(a.action);

  // bash：命令即摘要；approvalKey=原始命令（与旧「总是允许该前缀」语义完全一致）
  if (name === 'bash') {
    const command = str(a.command);
    return { display: command || name, approvalKey: command };
  }

  if (name === 'browser') {
    const act = action || '(?)';
    return {
      display: capStr(`browser ${act}${browserDetail(a)}`),
      approvalKey: `browser ${act}`,
    };
  }

  // MCP（mcp-bridge 聚合注册，名字形如 mcp__<server>__<tool>）
  if (name.startsWith('mcp__')) {
    return {
      display: capStr(`${mcpShortName(name)}${genericDetail(a)}`),
      approvalKey: name,
    };
  }

  // 其余动作语义工具：display 带动作与关键细节，approvalKey 锚定 <name> <action>
  let detail = '';
  if (name === 'files' || name === 'files_write') detail = str(a.path) ? ` ${str(a.path)}` : '';
  else if (name === 'render') detail = str(a.title) ? ` ${str(a.title)}` : '';
  else if (name === 'interactive') detail = str(a.kind) ? ` ${str(a.kind)}` : ''; // 交互卡的动作字段是 kind 不是 action
  else if (name === 'read_skill') detail = str(a.name) ? ` ${str(a.name)}` : '';
  else if (action) detail = genericDetail(a);

  const display = capStr(`${name}${action ? ` ${action}` : ''}${detail}`);
  return {
    display,
    approvalKey: action ? `${name} ${action}` : name,
  };
}
