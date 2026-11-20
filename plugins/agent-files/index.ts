/**
 * agent-files 插件前端半边：cap.tool.files-write（AI 写/编辑文件工具）。
 *
 * 定位：file-browser 的 cap.tool.fs 只有只读（roots/list/read）；本插件补
 * write/edit/patch 三个写面动作，走 agent-loop 既有审批链（danger: 'write'）。
 * 执行经 POST /api/files-write/exec（服务端半边见 server.mjs）。
 *
 * 工具命名 files_write：与只读 files 区分；一个工具多动作（action 参数），
 * 与 cap.tool.fs 的 describe 协议同构。
 *
 * 面板：极简——写开关状态透传（服务端 PLITE_FILES_WRITE / 审计），不做第二套配置面。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { AgentFilesPanel } from './Panel';
import './panel.css';

/** 工具描述（agent-loop 组装 OpenAI tools 用） */
const DESCRIPTOR = {
  cap: 'cap.tool.files-write',
  name: 'files_write',
  description:
    '结构化写入与编辑工作区文件（写面；读用 files 工具）。三个动作：\n' +
    'write=写整文件（path+content；自动建父目录；保持文件既有行尾；UTF-8）；\n' +
    'edit=精确替换（path+old_string+new_string；old_string 必须唯一匹配，多次出现需传 expected_replacements；0 次命中会返回最相近行提示）；\n' +
    'patch=多文件补丁（patch=完整信封：*** Begin Patch / *** Add File: / *** Update File: + @@锚点 + -旧 +新 行 / *** Delete File: / *** End Patch）。\n' +
    '路径支持绝对路径或相对工作区根；只能写内建 workspace 与已登记工作区根内；二进制文件拒写。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['write', 'edit', 'patch'], description: '要执行的动作' },
      path: { type: 'string', description: 'write/edit：目标文件路径（绝对，或相对工作区根）' },
      content: { type: 'string', description: 'write：要写入的完整内容' },
      old_string: { type: 'string', description: 'edit：要被替换的精确原文（含缩进与换行）' },
      new_string: { type: 'string', description: 'edit：替换后的文本（删除请传空串）' },
      expected_replacements: { type: 'number', description: 'edit：可选，old_string 预期出现次数；与实际不符时报错（防误替换）' },
      patch: { type: 'string', description: 'patch：完整补丁信封文本' },
      rootId: { type: 'string', description: '可选：工作区根 id（file-browser roots 返回；缺省按绝对路径/内建 workspace 解析）' },
    },
    required: ['action'],
  },
  danger: 'write' as const,
};

/** 执行（loop 调用；已通过 loop 层审批）。返回对齐 agent-bash 的 exec 形态（exitCode 供 loop 判定卡片状态）。 */
async function execFilesWrite(payload: Record<string, unknown>): Promise<{
  ok: boolean; exitCode?: number; durationMs?: number; [k: string]: unknown;
}> {
  const startedAt = Date.now();
  const resp = await fetch('/api/files-write/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      action: payload.action,
      path: payload.path,
      content: payload.content,
      old_string: payload.old_string,
      new_string: payload.new_string,
      expected_replacements: payload.expected_replacements,
      patch: payload.patch,
      rootId: payload.rootId,
      sessionId: payload.sessionId,
    }),
  });
  const json = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!resp.ok || !json || json.ok !== true) {
    return {
      ok: false,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      error: (json?.error as string) ?? `HTTP ${resp.status}`,
      code: json?.code as string,
      stdout: json?.error ? String(json.error) : undefined,
    };
  }
  // 结果摘要进 stdout（loop 的 feedback 直接展示给模型）：write/edit 报路径与字节数，patch 报 per-file summary
  const stdout = json.action === 'patch'
    ? ((json.summary as string[] | undefined) ?? []).join('\n') || 'patch applied'
    : `${String(json.action)} ok: ${String(json.path ?? '')}${json.bytes != null ? ` (${String(json.bytes)} bytes)` : ''}${json.replacements != null ? ` (${String(json.replacements)} replacement(s))` : ''}`;
  return { ok: true, exitCode: 0, durationMs: Date.now() - startedAt, stdout, ...json };
}

function createFilesWriteHandler(): CapabilityHandler {
  return async (req) => {
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    switch (req.action) {
      case 'describe':
        return { descriptor: DESCRIPTOR };
      case 'exec':
        return await execFilesWrite(payload);
      default:
        return { ok: false, error: `unknown action: ${req.action}` };
    }
  };
}

export const agentFilesPlugin: LitePlugin = {
  manifest: {
    id: 'agent-files',
    name: '文件编辑',
    version: '0.1.0',
    capabilities: [],
    provides: ['cap.tool.files-write'],
    events: ['tool-registered'],
    contributes: {
      slots: [{ slot: 'panel', component: 'AgentFilesPanel', order: 20, title: '文件编辑' }],
    },
  },
  setup(api: SlotHostApi) {
    api.registerCapability.register('cap.tool.files-write', createFilesWriteHandler());
    api.emit('tool-registered', { cap: 'cap.tool.files-write', name: DESCRIPTOR.name });
  },
};

export { AgentFilesPanel };
export default agentFilesPlugin;
