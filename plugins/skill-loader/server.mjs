/**
 * skill-loader 插件的服务端半边（/api/skills/*）：SKILL.md 发现与读取。
 *
 * 目录扫描序列（原生优先，同名先到先得——plans/extension-capability-pure-plugin-plan.md §2.2）：
 *   1. <dataDir>/skills              （polaris-lite 原生/兼容插件同步目录）
 *   2. <work>/.polaris-lite/skills   （workspace 原生）
 *   3. <work>/.claude/skills         （Claude Code 项目级）
 *   4. <work>/.zcode/skills          （ZCode workspace）
 *   5. <work>/.agents/skills         （跨工具兼容目录）
 * workspace 目录取 <dataDir>/workspace-roots.json 中当前激活根（与 agent-bash 同源）；
 * 无激活根时仅扫原生目录。
 *
 * 端点：
 *   GET /api/skills/list            → { skills: [{name, description, whenToUse, source}] }
 *   GET /api/skills/read?name=      → { ok, content }   （SKILL.md 全文，16KB 截断）
 *   GET /api/skills/appendix        → { text }           （系统提示附录：索引 + AGENTS.md/CLAUDE.md）
 *   POST /api/skills/reload         → { ok }             （清缓存强制重扫）
 *
 * 安全：会话门禁；PLITE_SKILLS=0 禁用；只读不写；内容截断防上下文爆炸。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_INDEX_DESC = 200;
const MAX_SKILL_BYTES = 16 * 1024;
const MAX_DOC_BYTES = 32 * 1024;

import { registerReadSkillTool } from './tool.mjs';

export function createServerPart(options = {}) {
  // 工具声明随插件：启用本插件即注册 read_skill 工具；禁用即消失。
  if (options.registry) registerReadSkillTool(options.registry);
  const getSession = options.getSession;
  const verifyTempToken = options.verifyTempToken ?? ((token) => false);
  const dataDir = resolve(options.dataDir ?? '.polaris-lite');
  const hardOff = process.env.PLITE_SKILLS === '0';

  /** mtime 缓存：目录序列 key → { skills, docText, scannedAt } */
  let cache = { key: '', skills: [], docText: '', scannedAt: 0 };

  function workspaceRoots() {
    try {
      const p = join(dataDir, 'workspace-roots.json');
      if (!existsSync(p)) return [];
      const j = JSON.parse(readFileSync(p, 'utf8'));
      return Array.isArray(j.roots) ? j.roots : [];
    } catch {
      return [];
    }
  }

  function activeWorkspace() {
    try {
      const p = join(dataDir, 'workspace-state.json');
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        if (j.activeRootPath) return j.activeRootPath;
      }
    } catch { /* 忽略 */ }
    try {
      const roots = JSON.parse(readFileSync(join(dataDir, 'workspace-roots.json'), 'utf8'));
      const list = Array.isArray(roots.roots) ? roots.roots : [];
      const hit = list.find((r) => r.path && !r.builtin) ?? list.find((r) => r.path);
      if (hit?.path && existsSync(hit.path)) return hit.path;
    } catch { /* 忽略 */ }
    // 兜底：宿主内建工作区（agent-bash 启动即 mkdir，始终存在）——
    // 修复：全新实例没有 workspace-state/roots 文件，此前返回 '' 导致只扫原生目录、
    // 工作区内的 .claude/skills 永远不被发现。
    return join(dataDir, 'workspace');
  }

  /** 解析 SKILL.md frontmatter（扁平 key: value；无 frontmatter 返回空对象） */
  function parseFrontmatter(text) {
    const lines = text.split(/\r?\n/);
    if (lines[0]?.trim() !== '---') return {};
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { end = i; break; }
    }
    if (end < 0) return {};
    const fm = {};
    for (const line of lines.slice(1, end)) {
      const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      if (m) fm[m[1]] = m[2].trim();
    }
    return fm;
  }

  function scanDir(dir, source, out) {
    if (!dir || !existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = join(dir, name);
      let isDir = false;
      try { isDir = statSync(p).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      const skillMd = join(p, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      let text = '';
      try { text = readFileSync(skillMd, 'utf8'); } catch { continue; }
      const fm = parseFrontmatter(text);
      const skillName = String(fm.name ?? '').trim() || name; // name 缺省回退目录名（对齐 Claude Code）
      if (out.some((s) => s.name === skillName)) continue;    // 同名先到先得（目录序即优先级）
      let description = String(fm.description ?? '').trim();
      if (description.length > 1024) description = description.slice(0, 1024) + '…'; // 截断不丢弃
      out.push({ name: skillName, description, whenToUse: String(fm.when_to_use ?? '').trim(), source, dir: p });
    }
  }

  function readDocUpward(startDir, filenames) {
    // 从 workspace 向上查找指令文件（AGENTS.md / CLAUDE.md），都存在则按序拼接
    const parts = [];
    let cur = startDir;
    for (let i = 0; i < 12 && cur; i++) {
      for (const f of filenames) {
        const p = join(cur, f);
        if (existsSync(p)) {
          try {
            const t = readFileSync(p, 'utf8').trim();
            if (t) parts.push(`<!-- ${f} @ ${p} -->\n${t}`);
          } catch { /* 不可读跳过 */ }
        }
      }
      const parent = resolve(cur, '..');
      if (parent === cur) break;
      cur = parent;
    }
    const text = parts.join('\n\n');
    return text.length > MAX_DOC_BYTES ? text.slice(0, MAX_DOC_BYTES) + '\n…[已截断]' : text;
  }

  function scanAll(force = false) {
    const ws = activeWorkspace();
    const dirs = [
      ['native', join(dataDir, 'skills')],
      // 内建工作区（始终扫描；agent-bash 的 bash cwd 兜底也是它）
      ['builtin-ws', join(dataDir, 'workspace', '.claude', 'skills')],
      ['workspace', ws && ws !== join(dataDir, 'workspace') ? join(ws, '.polaris-lite', 'skills') : ''],
      ['claude', ws ? join(ws, '.claude', 'skills') : ''],
      ['zcode', ws ? join(ws, '.zcode', 'skills') : ''],
      ['agents', ws ? join(ws, '.agents', 'skills') : ''],
    ];
    const key = JSON.stringify(dirs);
    if (!force && cache.key === key && Date.now() - cache.scannedAt < 5000) return { ...cache, ws };
    const skills = [];
    for (const [source, dir] of dirs) scanDir(dir, source, skills);
    const docText = ws ? readDocUpward(ws, ['AGENTS.md', 'CLAUDE.md']) : '';
    cache = { key, skills, docText, scannedAt: Date.now() };
    return { ...cache, ws };
  }

  function buildAppendix({ skills, docText }) {
    const parts = [];
    if (skills.length) {
      const lines = skills.map((s) => {
        const desc = s.description ? ` — ${s.description.slice(0, MAX_INDEX_DESC)}` : '';
        return `- ${s.name}${desc}`;
      });
      parts.push(
        '# Available skills\n' +
        '以下技能可用。当技能与当前任务相关时，先用 read_skill 工具（参数 name）读取完整说明再遵循执行：\n' +
        lines.join('\n'),
      );
    }
    // 自建扩展操作指引（runtime-extensions-and-market-final.md P1.3）：教会 AI 运行时创建技能/钩子/MCP server。
    // 2026-11-25 引擎优化 P0-3：这段对日常对话是纯噪声（每次会话固定占 system prompt）。
    // 降级为「一眼索引」——模型需要时用 read_skill/bash 查详情；完整指引移入技能库
    // （polaris-lite/.claude/skills/ 自建指引），不再整段注入。
    parts.push(
      '# 自建扩展指引（简版）\n' +
      '运行时可创建扩展（均实时生效）：技能=写 <工作区>/.claude/skills/<名>/SKILL.md；' +
      'MCP server=用 mcp_server_add 工具登记；钩子=编辑 <工作区>/.claude/settings.json 的 hooks 键（需用户在面板确认）。',
    );
    if (docText) parts.push('# Project instructions\n' + docText);
    return parts.join('\n\n');
  }

  return async function skillsApi(req, res, next) {
    if (hardOff) return next?.();
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith('/api/skills/')) return next?.();

    // 门禁：会话 cookie 或 本地回环 Bearer 临时凭证（同 agent-files 双认证惯例）
    const session = getSession?.(req);
    const bearer = String(req.headers.authorization ?? '');
    const bearerOk = bearer.startsWith('Bearer ') && verifyTempToken(bearer.slice(7));
    if (!session && !bearerOk) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized', code: 'SESSION_REQUIRED' }));
    }

    const sendJson = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };

    try {
      if (pathname === '/api/skills/list' && req.method === 'GET') {
        const { skills } = scanAll();
        return sendJson(200, { skills: skills.map(({ name, description, whenToUse, source }) => ({ name, description, whenToUse, source })) });
      }
      if (pathname === '/api/skills/read' && req.method === 'GET') {
        const url = new URL(req.url, 'http://x');
        const name = String(url.searchParams.get('name') ?? '').trim();
        const { skills } = scanAll();
        const hit = skills.find((s) => s.name === name);
        if (!hit) return sendJson(404, { ok: false, error: `技能不存在: ${name}` });
        let content = readFileSync(hit.dir + '/SKILL.md', 'utf8');
        if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_BYTES) {
          content = content.slice(0, MAX_SKILL_BYTES) + '\n…[已截断]';
        }
        return sendJson(200, { ok: true, content });
      }
      if (pathname === '/api/skills/appendix' && req.method === 'GET') {
        const { skills, docText } = scanAll();
        return sendJson(200, { text: buildAppendix({ skills, docText }) });
      }
      if (pathname === '/api/skills/reload' && req.method === 'POST') {
        scanAll(true);
        return sendJson(200, { ok: true });
      }
      return sendJson(404, { error: 'not found' });
    } catch (e) {
      return sendJson(400, { error: String(e?.message ?? e) });
    }
  };
}
