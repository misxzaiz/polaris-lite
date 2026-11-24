/**
 * extquad — 外部四合一验证插件（面板 + Skill + MCP + Hook）。
 *
 * 面板：panel 槽位，展示四通道状态与操作按钮。
 * Skill：把随包 SKILL.md 写入 <ws>/.claude/skills/extquad-note/SKILL.md（files-write 写面）。
 * MCP：POST /api/mcp/servers 登记一个 stdio server（随包 mcp-server.mjs）。
 * Hook：把一条 PostToolUse 审计钩子写入 <ws>/.claude/settings.json（新钩子需面板确认后执行）。
 *
 * 本插件零 server 半边：全部复用宿主已有插件能力（files-write / kv / mcp-bridge 管理面）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { LitePlugin, SlotHostApi } from '@sdk';
import './style.css';

let api: SlotHostApi | null = null;

interface Status {
  kv: 'unknown' | 'ok' | 'fail';
  skill: 'unknown' | 'written' | 'fail';
  mcp: 'unknown' | 'registered' | 'fail';
  hook: 'unknown' | 'written' | 'fail';
  log: string[];
}

const SKILL_PATH = '.claude/skills/extquad-note/SKILL.md';
const SKILL_CONTENT = [
  '---',
  'name: extquad-note',
  'description: extquad 外部插件携带的示例技能：验证 外部插件→工作区技能落盘→下轮对话进系统提示附录 全链路。',
  '---',
  '',
  '# extquad-note',
  '',
  '这是由外部插件 extquad 落盘的示例技能。',
  '当用户提到「extquad 技能验证」时，回答“外部插件 skill 通道 OK”。',
  '',
].join('\n');

const HOOK_SETTINGS = {
  hooks: {
    PostToolUse: [
      {
        matcher: '*',
        hooks: [
          { type: 'command', command: 'node -e "require(\'fs\').appendFileSync(\'extquad-hook.log\', String(Date.now())+\' post-tool-use\\n\')"', timeout: 10 },
        ],
      },
    ],
  },
};

async function filesWrite(path: string, content: string): Promise<{ ok: boolean; msg: string }> {
  try {
    const r = await fetch('/api/files-write/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action: 'write', path, content, sessionId: 'extquad-panel' }),
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j?.ok) return { ok: true, msg: 'ok' };
    return { ok: false, msg: j?.error ?? `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, msg: String((e as Error)?.message ?? e) };
  }
}

function ExtQuadPanel() {
  const [st, setSt] = useState<Status>({ kv: 'unknown', skill: 'unknown', mcp: 'unknown', hook: 'unknown', log: [] });
  const [busy, setBusy] = useState<string | null>(null);

  const log = useCallback((line: string) => {
    setSt((s) => ({ ...s, log: [`${new Date().toLocaleTimeString()}  ${line}`, ...s.log].slice(0, 40) }));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/kv/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ namespace: 'extquad', key: 'ping', value: { at: Date.now() } }),
        });
        const g = await fetch('/api/kv/get?namespace=extquad&key=ping', { credentials: 'include' });
        const ok = r.ok && g.ok;
        setSt((s) => ({ ...s, kv: ok ? 'ok' : 'fail' }));
        log(`kv 探活 ${ok ? '成功' : '失败'}`);
      } catch (e) {
        setSt((s) => ({ ...s, kv: 'fail' }));
        log(`kv 探活失败：${String((e as Error)?.message ?? e)}`);
      }
    })();
  }, [log]);

  const doSkill = async () => {
    setBusy('skill');
    const r = await filesWrite(SKILL_PATH, SKILL_CONTENT);
    setSt((s) => ({ ...s, skill: r.ok ? 'written' : 'fail' }));
    log(`skill 写入 ${r.ok ? '成功（下轮对话进技能附录）' : `失败：${r.msg}`}`);
    setBusy(null);
  };

  const doMcp = async () => {
    setBusy('mcp');
    try {
      const r = await fetch('/api/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: 'extquad-echo',
          command: 'node',
          // MCP server 是本地进程脚本（stdio），走文件系统路径而非 /ext-plugins URL
          //（安装器只复制 plugin.js/plugin.json/style.css 三个文件）。
          args: ['D:/space/base/polaris-lite/ext-plugins-src/extquad/mcp-server.mjs'],
          enabled: true,
        }),
      });
      const j = await r.json().catch(() => null);
      const ok = r.ok && j?.ok !== false && !j?.error;
      setSt((s) => ({ ...s, mcp: ok ? 'registered' : 'fail' }));
      log(`mcp 登记 ${ok ? '成功（下轮对话出现 mcp__extquad-echo__*）' : `失败：${j?.error ?? r.status}`}`);
    } catch (e) {
      setSt((s) => ({ ...s, mcp: 'fail' }));
      log(`mcp 登记失败：${String((e as Error)?.message ?? e)}`);
    }
    setBusy(null);
  };

  const doHook = async () => {
    setBusy('hook');
    const r = await filesWrite('.claude/settings.json', JSON.stringify(HOOK_SETTINGS, null, 2) + '\n');
    setSt((s) => ({ ...s, hook: r.ok ? 'written' : 'fail' }));
    log(`hook 写入 ${r.ok ? '成功（新钩子需在钩子面板确认后执行）' : `失败：${r.msg}`}`);
    setBusy(null);
  };

  const Dot = ({ v }: { v: Status['kv'] }) => (
    <span className={`extquad-dot ${v === 'ok' || v === 'written' || v === 'registered' ? 'extquad-ok' : v === 'fail' ? 'extquad-fail' : 'extquad-idle'}`} />
  );

  return (
    <div className="extquad-panel">
      <div className="extquad-head">
        <h3>extquad 四合一验证</h3>
        <p>外部插件 → 面板 / Skill / MCP / Hook 全链路冒烟</p>
      </div>
      <ul className="extquad-list">
        <li><Dot v={st.kv} /> 面板 + kv 探活（/api/kv）</li>
        <li>
          <Dot v={st.skill} /> Skill：写 {SKILL_PATH}
          <button type="button" disabled={busy === 'skill'} onClick={doSkill}>{busy === 'skill' ? '…' : '写入'}</button>
        </li>
        <li>
          <Dot v={st.mcp} /> MCP：登记 stdio server（extquad-echo）
          <button type="button" disabled={busy === 'mcp'} onClick={doMcp}>{busy === 'mcp' ? '…' : '登记'}</button>
        </li>
        <li>
          <Dot v={st.hook} /> Hook：写 .claude/settings.json（PostToolUse）
          <button type="button" disabled={busy === 'hook'} onClick={doHook}>{busy === 'hook' ? '…' : '写入'}</button>
        </li>
      </ul>
      <div className="extquad-log">
        {st.log.length === 0 ? <div className="extquad-log-empty">暂无日志</div> : st.log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
      <p className="extquad-note">注意：Skill/Hook 写入后下轮对话生效；Hook 新规则需在钩子面板确认一次；MCP 下轮 discoverTools 可见。</p>
    </div>
  );
}

export { ExtQuadPanel };

export const extquadPlugin: LitePlugin = {
  manifest: {
    id: 'extquad',
    name: 'extquad 四合一',
    version: '0.1.0',
    capabilities: [],
    contributes: {
      slots: [{ slot: 'panel', component: 'ExtQuadPanel', order: 40, title: 'extquad 验证台' }],
    },
  },
  setup(hostApi) {
    api = hostApi;
  },
};

export default extquadPlugin;
