/**
 * agent-bash 插件：AI 对话工具插件（第一个工具 = bash）。
 *
 * 职责（工具插件只做两件事，不做编排）：
 * 1. 向 agent-loop 提供**工具描述**（describe 动作），供模型 tools 数组；
 * 2. 执行：loop 传参 → 服务端 /api/tool/exec（会话 cookie 门禁 + denylist + 审计）→ 回传结果。
 *
 * 安全约定：
 * - 服务端是裁决者（模式/denylist/审计），本插件不做本地放行决策；
 * - 模式配置与「总是允许该前缀」持久化在服务端 .polaris-lite/tool-exec.json；
 * - 面板提供模式切换与白名单管理（panel 插槽）。
 *
 * 有 bash 就有了一切：AI 可用 bash 写脚本执行 → 等效获得任意一次性能力；
 * 但插件级常驻能力仍走 registry/grants 人工链，AI 不能自我提权。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { AgentBashPanel } from './Panel';
import './panel.css';

export interface ToolDescriptor {
  cap: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  danger: 'read' | 'write' | 'execute';
}

const DESC_BASE =
  '在工作区执行 shell 命令并返回 stdout/stderr/exitCode。' +
  '可用于读写文件、运行脚本、安装依赖、调用任意 CLI——需要衍生新能力时先想 bash。' +
  '限制：cwd 锁定工作区目录；单条超时默认 30s（最长 300s）；输出上限 64KB；' +
  '危险命令（rm -rf、curl|sh、改配置存储等）会被无条件拒绝。';

/** 按 server 实际执行环境给模型写对语法（config.shell 由 server.mjs 提供）。
 *  历史教训：固定写「Windows（cmd 语法）」，模型仍写 bash（2>/dev/null 等），
 *  cmd 下这些全报错；现在 server 有 Git Bash 就明说 bash 语法，反之明说 cmd。 */
function getDescriptor(): ToolDescriptor {
  const shell = serverConfig?.shell;
  const syntax = shell === 'cmd'
    ? '当前宿主为 Windows cmd：不支持 2>/dev/null、; 分隔与 $VAR——请用 cmd 等价写法（2>nul、& 分隔）。'
    : '当前宿主经 Git Bash 执行：写 POSIX bash 语法（2>/dev/null、管道、&&/; 分隔、$VAR 均可用）；Windows 路径 D:/x/y 与 /d/x/y 都接受。';
  return { ...DESCRIPTOR, description: DESC_BASE + syntax };
}

const DESCRIPTOR: ToolDescriptor = {
  cap: 'cap.tool.bash',
  name: 'bash',
  description: DESC_BASE,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令（完整一行）' },
      timeoutMs: { type: 'number', description: '超时毫秒，默认 30000，上限 300000' },
    },
    required: ['command'],
  },
  danger: 'execute',
};

/** 服务端工具配置（模式/白名单/实际 shell）缓存；exec 前刷新 */
let serverConfig: { enabled: boolean; mode: string; allowPrefixes: string[]; hardOff?: boolean; shell?: 'bash' | 'cmd' } | null = null;

async function fetchConfig(): Promise<typeof serverConfig> {
  try {
    const resp = await fetch('/api/tool/config', { credentials: 'include' });
    if (!resp.ok) return null;
    return (await resp.json()) as NonNullable<typeof serverConfig>;
  } catch {
    return null; // 路由不存在（旧宿主）→ 服务端裁决失败，exec 会 404，loop 会把错误喂回模型
  }
}

async function postConfig(patch: Record<string, unknown>): Promise<boolean> {
  try {
    const resp = await fetch('/api/tool/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(patch),
    });
    if (resp.ok) {
      serverConfig = (await resp.json()) as NonNullable<typeof serverConfig>;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 执行一条命令（loop 调用；已通过 loop 层的审批） */
async function execCommand(payload: { command?: string; timeoutMs?: number; approved?: boolean; sessionId?: string; cwd?: string }) {
  const command = String(payload.command ?? '').trim();
  if (!command) return { ok: false, error: 'command required' };
  const resp = await fetch('/api/tool/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      command,
      timeoutMs: payload.timeoutMs,
      approved: payload.approved === true,
      sessionId: payload.sessionId,
      cwd: payload.cwd,
    }),
  });
  const json = (await resp.json().catch(() => null)) as
    | { stdout: string; stderr: string; exitCode: number; durationMs: number; truncated: boolean; timedOut: boolean; error?: string; code?: string; denied?: boolean }
    | null;
  if (!resp.ok || !json) {
    return { ok: false, error: json?.error ?? `HTTP ${resp.status}`, denied: json?.denied === true, code: json?.code };
  }
  return { ok: true, ...json };
}

function createBashHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as { command?: string; timeoutMs?: number; approved?: boolean; sessionId?: string };
    switch (req.action) {
      case 'describe':
        // shell 信息决定给模型的语法指导；缓存未就绪（首回合竞态）就补拉一次
        if (!serverConfig) serverConfig = await fetchConfig();
        return { descriptor: getDescriptor() };
      case 'exec':
        return await execCommand(payload);
      case 'getConfig':
        serverConfig = await fetchConfig();
        return { config: serverConfig };
      case 'setMode':
        return { ok: await postConfig({ mode: payload.command }) };
      case 'addPrefix':
        return { ok: await postConfig({ addPrefix: payload.command }) };
      case 'removePrefix':
        return { ok: await postConfig({ removePrefix: payload.command }) };
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

export const agentBashPlugin: LitePlugin = {
  manifest: {
    id: 'agent-bash',
    name: 'Bash 工具',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.tool.bash'],
    events: ['tool-registered'],
    contributes: {
      // title 是面板 tab 文本（四等分后每格约 74px，写全名「Bash 工具」会被截断）
      slots: [{ slot: 'panel', component: 'AgentBashPanel', order: 3, title: 'Bash' }],
    },
  },
  setup(api: SlotHostApi) {
    api.registerCapability.register('cap.tool.bash', createBashHandler());
    // 广播工具注册（loop 若已装配也能收到；主要发现路径是 loop 启动时主动拉取 describe）
    api.emit('tool-registered', { cap: 'cap.tool.bash', name: DESCRIPTOR.name });
    void fetchConfig().then((cfg) => { serverConfig = cfg; });
  },
};

export { AgentBashPanel };

export default agentBashPlugin;
