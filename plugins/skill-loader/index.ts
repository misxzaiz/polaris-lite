/**
 * skill-loader 插件：SKILL.md 技能发现 + read_skill 工具 + 系统提示附录。
 *
 * 职责（plans/extension-capability-pure-plugin-plan.md §2.2）：
 * 1. 扫描技能目录序列（原生优先，同名先到先得）：
 *      <dataDir>/skills  →  <work>/.polaris-lite/skills  →  <work>/.claude/skills
 *      →  <work>/.zcode/skills  →  <work>/.agents/skills
 *    每个 skill = 一级子目录 + SKILL.md（YAML frontmatter: name/description/when_to_use）。
 *    兼容 Claude Code / ZCode 的既有 SKILL.md，文件零改动可用。
 * 2. cap.skill.appendix#get → 系统提示附录：技能索引 + 使用说明 + AGENTS.md/CLAUDE.md 正文
 *    （agent-loop 组装 system prompt 时注入；本插件未装时该 cap 不存在，agent-loop 零影响）。
 * 3. cap.tool.skill → read_skill 工具（进 agent-loop 的 tools 数组），按需返回 SKILL.md 全文。
 *
 * 安全模型：
 * - server 半边只读外部目录（发现/读取），不写任何 workspace 文件；
 * - SKILL.md 内容进入模型上下文前做长度截断（索引行 200 字符 / 全文 16KB）；
 * - PLITE_SKILLS=0 一键禁用（server 半边 404，浏览器半边 describe 报不可用）。
 */
import type { CapabilityHandler, LitePlugin, SlotHostApi } from '@sdk';
import { SkillPanel } from './Panel';
import './panel.css';

interface SkillDescriptor {
  name: string;
  description: string;
  parameters: unknown;
}

const READ_SKILL_DESCRIPTOR: SkillDescriptor = {
  name: 'read_skill',
  description:
    '读取指定技能（skill）的完整 SKILL.md 内容。当「# Available skills」索引中的技能与当前任务相关时调用；name 为索引中列出的技能名。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（见 # Available skills 索引）' },
    },
    required: ['name'],
  },
};

function createSkillToolHandler(): CapabilityHandler {
  return async (req) => {
    if (req.action === 'describe') {
      return { descriptor: { cap: 'cap.tool.skill', ...READ_SKILL_DESCRIPTOR, danger: 'read' } };
    }
    if (req.action === 'exec') {
      const payload = (req.payload ?? {}) as { name?: string };
      const name = String(payload.name ?? '').trim();
      if (!name) return { ok: false, error: 'name required' };
      try {
        const resp = await fetch(`/api/skills/read?name=${encodeURIComponent(name)}`, { credentials: 'include' });
        const j = (await resp.json().catch(() => null)) as { ok?: boolean; content?: string; error?: string } | null;
        if (!resp.ok || !j?.ok) return { ok: false, error: j?.error ?? `HTTP ${resp.status}` };
        return { ok: true, stdout: j.content ?? '', exitCode: 0 };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: false, error: `unknown action: ${req.action}` };
  };
}

function createAppendixHandler(): CapabilityHandler {
  return async (req) => {
    if (req.action !== 'get') return { ok: false, error: `unknown action: ${req.action}` };
    try {
      const resp = await fetch('/api/skills/appendix', { credentials: 'include' });
      const j = (await resp.json().catch(() => null)) as { text?: string } | null;
      return { ok: true, text: j?.text ?? '' };
    } catch (err) {
      return { ok: true, text: '' }; // 附录不可用不阻塞会话
    }
  };
}

export const skillLoaderPlugin: LitePlugin = {
  manifest: {
    id: 'skill-loader',
    name: '技能加载器',
    version: '0.2.0',
    capabilities: ['cap.meta'],
    provides: ['cap.tool.skill', 'cap.skill.appendix'],
    events: ['tool-registered'],
    contributes: {
      slots: [{ slot: 'panel', component: 'SkillPanel', order: 22, title: '技能' }],
    },
  },
  setup(api: SlotHostApi) {
    api.registerCapability.register('cap.tool.skill', createSkillToolHandler());
    api.registerCapability.register('cap.skill.appendix', createAppendixHandler());
    api.emit('tool-registered', { cap: 'cap.tool.skill', name: READ_SKILL_DESCRIPTOR.name });
  },
};

export { SkillPanel };
export default skillLoaderPlugin;
