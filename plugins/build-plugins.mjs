#!/usr/bin/env node
/**
 * build-plugins.mjs：构建全部外部插件并生成宿主可拉取的注册表。
 *
 * 外部注册机制：插件与宿主零源码耦合——
 * - 插件各自独立构建为 ESM bundle（react 外部化，由宿主 import map 提供）；
 * - 产物连同 plugin 清单复制到宿主 public/plugins/<id>/；
 * - 生成 public/plugins/registry.json，宿主启动时 fetch + 动态 import。
 *
 * 校验策略：**fail-fast，绝不产出「半可用」的产物集**。
 * 以前这个脚本只做拼接，出错都推迟到运行时才以控制台告警的形式暴露——
 * 「漏登记 grants」「manifest.id 与目录名不一致」「忘了复制 esm-shim」这类问题
 * 全都表现为「插件静默不加载」，排查成本极高。现在一律在构建期失败并指明原因。
 *
 *  A. 构建前（静态一致性，零成本失败）
 *     1. 清单条目 id / config / dist 无重复；目录、vite 配置、入口文件真实存在
 *     2. 源码 manifest.id 必须与目录名一致（public/plugins/<dir>/ 即插件对外身份）
 *     3. manifest.requires 的每个能力，必须有**已启用**插件在 provides 里覆盖
 *     4. public/grants.json 必须登记该插件，且 manifest 申请项 ⊆ 授权项
 *        （grants 是宿主侧唯一事实来源，漏登记会在运行时被静默收紧权限）
 *  B. 构建后（产物完整性）
 *     5. dist/plugin.js 存在且非空；有 style.css 才写进 plugin.json 的 style 字段
 *     6. 复制到 public/plugins/<id>/ 后复核；plugin.json 回读比对
 *     7. 产物内不得残留疑似真实密钥（sk- 长串）
 *     8. 产物内必须含字面量 id（构建后自证身份，防止打包错入口）
 *  C. 收尾（注册表）
 *     9. 清理 public/plugins 下的陈旧插件目录（仅限含 plugin.json 且 id 不在清单内的）
 *    10. registry.json 回读校验：id 唯一、每个 module 指向真实存在的文件
 *
 * 用法：
 *   node plugins/build-plugins.mjs              # 校验 + 构建 + 生成注册表
 *   node plugins/build-plugins.mjs --skip-build # 复用现有 dist，只做产物校验与注册表生成
 *   node plugins/build-plugins.mjs --check      # 只跑静态一致性校验（CI 快速门禁）
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseViewContributions, validateViews, isExported } from './manifest-views.mjs';

const pluginsRoot = dirname(fileURLToPath(import.meta.url));
const hostRoot = resolve(pluginsRoot, '..');
const hostPublic = resolve(hostRoot, 'public/plugins');
const grantsFile = resolve(hostRoot, 'public/grants.json');
const ESM_SHIM = 'esm-shim.mjs';

const argv = new Set(process.argv.slice(2));
const SKIP_BUILD = argv.has('--skip-build');
const CHECK_ONLY = argv.has('--check');

/**
 * 插件清单。`order` 只决定 registry 的书写顺序与产物列表；
 * **装配顺序由 manifest.requires 拓扑排序决定**（宿主启动时按「能力提供方先装配」排序）。
 * mock-engine：验收/演示用途，默认停用；启用会与 real-engine 抢注 cap.ai.chat。
 */
const plugins = [
  { id: 'config-manager', config: 'config-manager/vite.config.ts', dist: 'config-manager/dist', order: 1 },
  { id: 'chat-lite', config: 'chat-lite/vite.config.ts', dist: 'chat-lite/dist', order: 2 },
  { id: 'model-admin', config: 'model-admin/vite.config.ts', dist: 'model-admin/dist', order: 3 },
  { id: 'real-engine', config: 'real-engine/vite.config.ts', dist: 'real-engine/dist', order: 4 },
  { id: 'agent-bash', config: 'agent-bash/vite.config.ts', dist: 'agent-bash/dist', order: 5 },
  { id: 'agent-loop', config: 'agent-loop/vite.config.ts', dist: 'agent-loop/dist', order: 6 },
  { id: 'agent-files', config: 'agent-files/vite.config.ts', dist: 'agent-files/dist', order: 7 },
  { id: 'cap-panel', config: 'cap-panel/vite.config.ts', dist: 'cap-panel/dist', order: 8 },
  { id: 'mock-auth', config: 'mock-auth/vite.config.ts', dist: 'mock-auth/dist', order: 9 },
  { id: 'mock-engine', config: 'mock-engine/vite.config.ts', dist: 'mock-engine/dist', order: 10, enabled: false },
  { id: 'file-browser', config: 'file-browser/vite.config.ts', dist: 'file-browser/dist', order: 11 },
  { id: 'theme-switcher', config: 'theme-switcher/vite.config.ts', dist: 'theme-switcher/dist', order: 12 },
  { id: 'ai-events', config: 'ai-events/vite.config.ts', dist: 'ai-events/dist', order: 13 },
  { id: 'interactive-cards', config: 'interactive-cards/vite.config.ts', dist: 'interactive-cards/dist', order: 14 },
  { id: 'html-preview', config: 'html-preview/vite.config.ts', dist: 'html-preview/dist', order: 15 },
  { id: 'pocket-ledger', config: 'pocket-ledger/vite.config.ts', dist: 'pocket-ledger/dist', order: 16 },
  { id: 'kv-store', config: 'kv-store/vite.config.ts', dist: 'kv-store/dist', order: 17 },
  { id: 'browser-lite', config: 'browser-lite/vite.config.ts', dist: 'browser-lite/dist', order: 17 },
  // Git 能力（cap.git 提供方，server 半边）+ Git 面板（消费方；requires 保证 core 先装配）
  { id: 'git-core', config: 'git-core/vite.config.ts', dist: 'git-core/dist', order: 23 },
  { id: 'git-panel', config: 'git-panel/vite.config.ts', dist: 'git-panel/dist', order: 24 },
  { id: 'chat-store', config: 'chat-store/vite.config.ts', dist: 'chat-store/dist', order: 19 },
  { id: 'plugin-manager', config: 'plugin-manager/vite.config.ts', dist: 'plugin-manager/dist', order: 18 },
  { id: 'mobile-companion', config: 'mobile-companion/vite.config.ts', dist: 'mobile-companion/dist', order: 20 },
  // 应用更新（App 刷新引导）：版本检查 + 24h 惰性提示；server 半边提供版本端点
  { id: 'app-updater', config: 'app-updater/vite.config.ts', dist: 'app-updater/dist', order: 21 },
  { id: 'phone-agent', config: 'phone-agent/vite.config.ts', dist: 'phone-agent/dist', order: 22 },
  { id: 'standalone-mode', config: 'standalone-mode/vite.config.ts', dist: 'standalone-mode/dist', order: 22 },
  // CodeBuddy CLI 引擎（服务端半边 spawn adapter.js → codebuddy CLI）。
  // 与 real-engine 互斥：cap.ai.chat 是单注册位，registry 里两者只能 enabled 一个。
  // 当前主用 real-engine（OpenAI 兼容中继），codebuddy-engine 产物保留但默认停用；
  // 需要切引擎时把 enabled 改回 true 并同步把 real-engine 置 enabled: false。
  { id: 'codebuddy-engine', config: 'codebuddy-engine/vite.config.ts', dist: 'codebuddy-engine/dist', order: 23, enabled: false },
  // 扩展能力插件（plans/extension-capability-pure-plugin-plan.md）：
  // skill-loader = SKILL.md 技能发现 + read_skill 工具 + 系统提示附录（AGENTS.md/CLAUDE.md）；
  // hook-bridge  = 生命周期钩子（CC/ZC hooks 兼容，进程执行器在 server 半边）。
  { id: 'skill-loader', config: 'skill-loader/vite.config.ts', dist: 'skill-loader/dist', order: 24 },
  { id: 'hook-bridge', config: 'hook-bridge/vite.config.ts', dist: 'hook-bridge/dist', order: 25 },
  // mcp-bridge = MCP server 接入（stdio JSON-RPC client 池 + cap.tool.mcp 聚合工具 + 管理面）
  { id: 'mcp-bridge', config: 'mcp-bridge/vite.config.ts', dist: 'mcp-bridge/dist', order: 26 },
  // zcode-compat = CC/ZC 扩展文件扫描与固化导入（纯导入器，能力由上面三个插件承载）
  { id: 'zcode-compat', config: 'zcode-compat/vite.config.ts', dist: 'zcode-compat/dist', order: 27 },
  // plugin-market = 外部插件商城与运行时安装器（plans/runtime-extensions-and-market-final.md P2）
  { id: 'plugin-market', config: 'plugin-market/vite.config.ts', dist: 'plugin-market/dist', order: 28 },
  // transcript-share = AI 对话全过程只读分享（needs #069）：链接分享接口（token+有效期）+ panel + cap.tool.transcript
  { id: 'transcript-share', config: 'transcript-share/vite.config.ts', dist: 'transcript-share/dist', order: 29 },
  // shell-chrome = 多面板 tab 条 chrome 的插件化实现（host-slimming-report §7.2/P1-2;containers 契约首个消费者）
  { id: 'shell-chrome', config: 'shell-chrome/vite.config.ts', dist: 'shell-chrome/dist', order: 30 },
  // workspace-layout = 工作区布局树插件化（host-slimming-report §7.1/P2-2;layout-root 容器）
  { id: 'workspace-layout', config: 'workspace-layout/vite.config.ts', dist: 'workspace-layout/dist', order: 31 },
  // personal-hub = 个人空间（自 Polaris PersonalHub 迁移）：Supabase 直连的导航/书签/待办
  { id: 'personal-hub', config: 'personal-hub/vite.config.ts', dist: 'personal-hub/dist', order: 32 },
  // voice-radio = AI 无限语音电台（自 Polaris Radio Broadcast 移植）：cap.ai.chat 段循环 + MiMo TTS 服务端代理
  { id: 'voice-radio', config: 'voice-radio/vite.config.ts', dist: 'voice-radio/dist', order: 33 },
  // starter-suggestions = 新会话开场建议池（cap.kv 持久化 + cap.tool.suggestions 供 AI 实时增改 + panel 管理面）
  { id: 'starter-suggestions', config: 'starter-suggestions/vite.config.ts', dist: 'starter-suggestions/dist', order: 34 },
].sort((a, b) => a.order - b.order);

class BuildError extends Error {}
function fail(msg) {
  throw new BuildError(msg);
}
function ok(msg) {
  console.log(`  ok  ${msg}`);
}

/** 剥离 JS 注释：注释里提到通道名/端点属正常文档，不算实现违规 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 从插件源码里取出 manifest 对象字面量的文本（括号配对，跳过字符串与注释） */
function extractBalanced(src, startIdx) {
  let depth = 0;
  let quote = null;
  let inLine = false;
  let inBlock = false;
  for (let i = startIdx; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  return null;
}

/** 解析插件源码 manifest：id / version / capabilities / provides / requires / events */
/**
 * 配对提取「含方括号或花括号」的一段源码。
 *
 * 为什么不复用 extractBalanced：它只认 `{}`。传入 `[` 时 depth 一直是 0，
 * 遇到数组里第一个对象的 `}` 就提前返回，拿到半截内容——静默解析错比解析失败更糟。
 * contributes.slots 是「对象数组」，两种括号必然交错，所以这里对 `[]` 与 `{}` 统一计数。
 */
function extractBracketed(src, startIdx) {
  const opener = src[startIdx];
  if (opener !== '[' && opener !== '{') return null;
  let depth = 0;
  let quote = null;
  let inLine = false;
  let inBlock = false;
  for (let i = startIdx; i < src.length; i += 1) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  return null;
}

/**
 * 解析 manifest.contributes.slots[]（对象数组）。
 *
 * 为什么必须在构建期读到：槽位与顺序是「多插件共存」的唯一秩序来源。等到运行时才发现
 * 「两个插件抢同一个 order」或「panel 槽没写 title」，症状是 tab 顺序随机漂移、tab 名被
 * 截断成乱码，而那时已经排不动了。
 *
 * 约定：slots 项必须是对象字面量、字段值必须是字面量。写成变量或函数调用会解析失败，
 * 这是有意的——manifest 要能被静态校验，就不能是运行时算出来的。
 */
function readSlotContributions(literal, pluginId) {
  const at = /\bcontributes\s*:\s*\{/.exec(literal);
  if (!at) return [];
  const contributes = extractBracketed(literal, at.index + at[0].length - 1);
  if (!contributes) fail(`插件 ${pluginId}：manifest.contributes 括号不闭合`);

  const slotsAt = /\bslots\s*:\s*\[/.exec(contributes);
  if (!slotsAt) return [];
  const arr = extractBracketed(contributes, slotsAt.index + slotsAt[0].length - 1);
  if (!arr) fail(`插件 ${pluginId}：manifest.contributes.slots 方括号不闭合`);

  const items = [];
  let i = 0;
  while (i < arr.length) {
    if (arr[i] === '{') {
      const body = extractBracketed(arr, i);
      if (!body) fail(`插件 ${pluginId}：contributes.slots 里有不闭合的对象字面量`);
      const str = (field) => {
        const m = new RegExp(`\\b${field}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`).exec(body);
        return m ? m[1] : undefined;
      };
      const num = (field) => {
        const m = new RegExp(`\\b${field}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(body);
        return m ? Number(m[1]) : undefined;
      };
      items.push({ slot: str('slot'), component: str('component'), order: num('order'), title: str('title') });
      i += body.length;
      continue;
    }
    i += 1;
  }
  return items;
}

/**
 * 插件样式门禁：静态扫描 CSS 文本。
 *
 * 背景：插件 CSS 目前是全局注入（无隔离），一份 `.slot-tab { display:none }` 就能改掉
 * 宿主 tab 栏。布局自由度越高、同屏插件越多，这个口子越致命。约束只能靠文本层面的
 * 静态判定来强制——它能给出确定结论，不依赖运行时。
 *
 * 返回 { errors, warnings }：errors 直接中止构建；warnings 只提示（存量问题逐步清零）。
 */
function lintPluginCss(cssText, label) {
  const errors = [];
  const warnings = [];
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, '');

  const forbidden = [
    { re: /(^|[\s,{}]):root\b/, msg: ':root 只属于宿主令牌层，插件不得改写全局主题变量' },
    { re: /(^|[\s,{}])html\b(?![\w-])/, msg: 'html 选择器会越过宿主命名空间' },
    { re: /(^|[\s,{}])body\b(?![\w-])/, msg: 'body 选择器会越过宿主命名空间（滚动锁等请走宿主 API）' },
    { re: /#root\b/, msg: '#root 是宿主挂载点' },
    { re: /@import\b/, msg: '禁止 @import（会引入不受门禁约束的外部样式）' },
    { re: /(^|[\s,{}])\*\s*[,{]/, msg: '禁止裸 * 选择器（只允许作用于自身容器内）' },
    { re: /position\s*:\s*fixed/, msg: 'position: fixed 会逃出窗格并盖住分隔条与抽屉，需要浮层请申请 cap.ui.overlay' },
    { re: /\.(slot|shell|polaris-lite-shell)[\w-]*/, msg: '插件不得选中宿主类名（.slot-* / .shell-* / .polaris-lite-shell）' },
  ];

  for (const rule of forbidden) {
    if (rule.re.test(stripped)) errors.push(`${label}：${rule.msg}`);
  }

  // !important 一律降为 warning：reduced-motion 下的 `animation: none !important` 是正当用法，
  // 但 `margin: 0 !important` 这类会随样式顺序变化而反复失效，应改用提高特异性。
  const bangs = stripped.split('\n').filter((line) => line.includes('!important'));
  for (const line of bangs) {
    warnings.push(`${label}：出现 !important（仅 reduced-motion 例外）：${line.trim().slice(0, 60)}`);
  }

  return { errors, warnings };
}

/** contributes.views 的解析（解析错误直接中止构建：manifest 必须静态可判） */
function parseViews(literal, pluginId) {
  const { items, errors } = parseViewContributions(literal, pluginId);
  if (errors.length) fail(errors.join('\n      '));
  return items;
}

/** 解析插件源码 manifest：id / version / capabilities / provides / requires / events / slots / views */
function readSourceManifest(p) {
  const dir = resolve(pluginsRoot, p.id);
  const entry = ['index.ts', 'index.tsx'].find((f) => existsSync(resolve(dir, f)));
  if (!entry) fail(`插件 ${p.id}：目录下找不到入口 index.ts / index.tsx`);

  const src = readFileSync(resolve(dir, entry), 'utf8');
  const m = /\bmanifest\s*:\s*\{/.exec(src);
  if (!m) fail(`插件 ${p.id}：${entry} 里找不到 manifest 对象字面量`);
  const literal = extractBalanced(src, m.index + m[0].length - 1);
  if (!literal) fail(`插件 ${p.id}：manifest 对象括号不闭合`);

  const idMatch = /\bid\s*:\s*['"`]([^'"`]+)['"`]/.exec(literal);
  if (!idMatch) fail(`插件 ${p.id}：manifest 缺少字符串字面量 id`);

  const list = (field) => {
    const hit = new RegExp(`\\b${field}\\s*:\\s*\\[([^\\]]*)\\]`).exec(literal);
    if (!hit) return [];
    if (hit[1].includes('{')) fail(`插件 ${p.id}：manifest.${field} 必须是字符串数组`);
    return [...hit[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
  };

  return {
    entry,
    id: idMatch[1],
    version: (/\bversion\s*:\s*['"`]([^'"`]+)['"`]/.exec(literal) ?? [])[1] ?? '?',
    capabilities: list('capabilities'),
    provides: list('provides'),
    requires: list('requires'),
    events: list('events'),
    slots: readSlotContributions(literal, p.id),
    views: parseViews(literal, p.id),
    containers: readContainerContributions(literal, p.id),
  };
}

/**
 * 解析 contributes.containers（host-slimming-report 必修包修2:P1 校验盲区焊死）。
 * 容器名拼错此前会构建期放行、运行时静默回退、无任何提示——与「插件静默不加载」
 * 同级的故障类别,必须在构建期挡掉。kind 受控枚举;component 必须非空字符串。
 */
function readContainerContributions(literal, pluginId) {
  const CONTAINER_KINDS = new Set(['slot-tabs', 'layout-root']);
  const m = /\bcontainers\s*:\s*\[/.exec(literal);
  if (!m) return [];
  const arrStart = literal.indexOf('[', m.index);
  const arrText = extractBracketed(literal, arrStart);
  if (!arrText) fail(`插件 ${pluginId}：manifest.containers 括号不闭合`);
  const items = [];
  const objRe = /\{\s*container[\s\S]*?\}/g;
  for (const hit of arrText.matchAll(objRe)) {
    const obj = hit[0];
    const kind = (/\bcontainer\s*:\s*['"`]([^'"`]+)['"`]/.exec(obj) ?? [])[1];
    if (!kind) fail(`插件 ${pluginId}：containers 项缺少 container 字段`);
    if (!CONTAINER_KINDS.has(kind)) {
      fail(`插件 ${pluginId}：未知容器 "${kind}"（合法值：${[...CONTAINER_KINDS].join(' / ')}）。拼错的容器运行时静默回退，必须挡在构建期`);
    }
    const comp = (/\bcomponent\s*:\s*['"`]([^'"`]+)['"`]/.exec(obj) ?? [])[1];
    if (!comp) fail(`插件 ${pluginId}：containers.${kind} 缺少 component 字段`);
    const orderRaw = (/\border\s*:\s*(\d+)/.exec(obj) ?? [])[1];
    items.push({ container: kind, component: comp, order: orderRaw ? Number(orderRaw) : 0 });
  }
  return items;
}

// ============================================================================
// A. 构建前：静态一致性校验
// ============================================================================
function preflight() {
  console.log('[1/3] 静态一致性校验');

  // 清单自检：id / config / dist 不得重复
  const seen = new Map();
  for (const key of ['id', 'config', 'dist']) {
    const dup = plugins.filter((p, i) => plugins.findIndex((q) => q[key] === p[key]) !== i);
    if (dup.length) fail(`插件清单 ${key} 重复：${dup.map((p) => p[key]).join('、')}`);
    for (const p of plugins) {
      const prev = seen.get(`${key}:${p[key]}`);
      if (prev) fail(`插件清单 ${key} 冲突：${prev} 与 ${p.id} 都是 ${p[key]}`);
      seen.set(`${key}:${p[key]}`, p.id);
    }
  }

  // 目录 / vite 配置 / 入口文件
  const manifests = new Map();
  for (const p of plugins) {
    if (!existsSync(resolve(pluginsRoot, p.id))) fail(`插件目录不存在：plugins/${p.id}`);
    if (!existsSync(resolve(pluginsRoot, p.config))) fail(`插件 ${p.id}：vite 配置不存在 ${p.config}`);
    const mf = readSourceManifest(p);
    if (mf.id !== p.id) {
      fail(`插件 ${p.id}：manifest.id 为 "${mf.id}"，与目录名不一致（产物会挂到 /plugins/${p.id}/ 下）`);
    }
    manifests.set(p.id, mf);
  }
  ok(`${plugins.length} 个插件的目录 / 配置 / 入口齐备，manifest.id 与目录名一致`);

  // requires ⊆ 已启用插件的 provides
  const enabled = plugins.filter((p) => p.enabled !== false);
  const providedBy = new Map();
  for (const p of enabled) {
    for (const cap of manifests.get(p.id).provides) {
      if (providedBy.has(cap)) {
        console.warn(
          `  warn ${cap} 同时由 ${providedBy.get(cap)} 与 ${p.id} 提供（运行时会抢占注册，请确认这是预期）`,
        );
      } else {
        providedBy.set(cap, p.id);
      }
    }
  }
  const orphanRequires = [];
  for (const p of enabled) {
    for (const cap of manifests.get(p.id).requires) {
      if (!providedBy.has(cap)) orphanRequires.push(`${p.id} → ${cap}`);
    }
  }
  if (orphanRequires.length) {
    fail(`以下 requires 没有任何已启用插件提供（运行期只能告警 + 依赖缺失）：\n      ${orphanRequires.join('\n      ')}`);
  }
  ok('manifest.requires 均已被已启用插件的 provides 覆盖');

  // grants.json 交叉校验：登记 + 申请项 ⊆ 授权项
  if (!existsSync(grantsFile)) fail(`授权表缺失：public/grants.json`);
  let grants;
  try {
    grants = JSON.parse(readFileSync(grantsFile, 'utf8'));
  } catch (err) {
    fail(`public/grants.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const granted = grants.plugins ?? {};
  const unlisted = plugins.filter((p) => !granted[p.id]).map((p) => p.id);
  if (unlisted.length) {
    fail(`以下插件未在 public/grants.json 登记（运行时会被按 manifest 自声明放行并告警）：\n      ${unlisted.join('\n      ')}`);
  }
  const subsetIssues = [];
  for (const p of plugins) {
    const mf = manifests.get(p.id);
    const g = granted[p.id] ?? {};
    for (const field of ['capabilities', 'provides', 'events']) {
      const allow = new Set(g[field] ?? []);
      const missing = (mf[field] ?? []).filter((x) => !allow.has(x));
      if (missing.length) subsetIssues.push(`${p.id}.${field} 申请未授权：${missing.join('、')}`);
    }
  }
  if (subsetIssues.length) {
    fail(`manifest 申请项超出 grants.json 授权（会被运行时收紧）：\n      ${subsetIssues.join('\n      ')}`);
  }
  const stale = Object.keys(granted).filter((id) => !plugins.some((p) => p.id === id));
  if (stale.length) console.warn(`  warn public/grants.json 存在已下线插件的条目：${stale.join('、')}`);
  ok('public/grants.json 覆盖全部插件，且无越权申请');

  // 槽位秩序：同一槽位内的 order 必须唯一。
  // 并列 order 会让顺序取决于插件加载时序（registry 顺序 + 依赖拓扑序），
  // 表现为「tab 顺序偶尔变化」——最难复现、最难排查的一类问题。
  const bySlot = new Map();
  for (const p of plugins) {
    for (const s of manifests.get(p.id).slots) {
      if (!s.slot) fail(`插件 ${p.id}：contributes.slots 项缺少 slot 字段`);
      if (!s.component) fail(`插件 ${p.id}：contributes.slots 项缺少 component 字段`);
      const order = s.order ?? 0;
      const key = `${s.slot}#${order}`;
      const prev = bySlot.get(key);
      if (prev) {
        fail(`槽位 ${s.slot} 的 order=${order} 被 ${prev} 与 ${p.id} 同时占用（顺序会随加载时序漂移），请改用唯一 order`);
      }
      bySlot.set(key, p.id);
      // panel 槽的 title 是 tab 文本；缺省回退插件名，长度不可控（等分宽度下会被截断）
      if (s.slot === 'panel' && !s.title) {
        fail(`插件 ${p.id}：panel 槽必须声明 title（tab 等分后全名必被截断，回退插件名不可控）`);
      }
    }
  }
  ok(`槽位贡献 ${bySlot.size} 项：order 唯一，panel 槽均有 title`);

  // 视图贡献：布局树里的每个叶子都靠 viewType 解析成组件，所以必须挡在构建期。
  // 判定逻辑在 plugins/manifest-views.mjs（纯函数，测试可直接跑负例）。
  const viewSeen = new Map();
  let viewCount = 0;
  for (const p of plugins) {
    const mf = manifests.get(p.id);
    const entrySrc = readFileSync(resolve(pluginsRoot, p.id, mf.entry), 'utf8');
    const errors = validateViews({ pluginId: p.id, entrySrc, views: mf.views, seen: viewSeen });
    if (errors.length) fail(errors.join('\n      '));
    viewCount += mf.views.length;
  }
  ok(`视图贡献 ${viewCount} 项：viewType 前缀与唯一性、title、组件导出均已校验`);

  // 插件样式门禁（源文件级）。样式逃逸是布局自由度提升后第一个会爆的地方：
  // 插件 CSS 全局注入、无隔离，一份 `.slot-tab{display:none}` 就能改掉宿主 tab 栏。
  let cssWarnings = 0;
  for (const p of plugins) {
    const dir = resolve(pluginsRoot, p.id);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.css'))) {
      const label = `plugins/${p.id}/${file}`;
      const { errors, warnings } = lintPluginCss(readFileSync(resolve(dir, file), 'utf8'), label);
      if (errors.length) fail(errors.join('\n      '));
      for (const w of warnings) {
        console.warn(`  warn ${w}`);
        cssWarnings += 1;
      }
    }
  }
  ok(`插件样式门禁通过${cssWarnings ? `（${cssWarnings} 条提示）` : ''}`);

  // 暗通道门禁（host-slimming-report §3 闸 2）：插件源码禁止出现裸跨插件通道字面量。
  // 背景：跨插件集成曾靠各自硬编码的 window 全局名 / storage 键（"暗通道"），不在
  // manifest/grants 里可见，替换一方会静默打断另一方。通道名已收编进 @sdk 契约常量
  // （CHANNEL_* / KEY_*），新通道必须先在 sdk 登记再使用，否则这里 fail-fast。
  // 注：stripComments 后只剩实现代码，注释里提到通道名不算违规。
  const DARK_CHANNELS = [
    '__PLITE_FILE_BROWSER_COMPOSE__',
    '__PLITE_INTERACTIVE_RESPOND__',
    '__PLITE_ARTIFACT_RENDERERS__',
    '__PLITE_REAL_ENGINE_DIRECT__',
    '__PLITE_LAYOUT_WIRE__',
    '__PLITE_DRAWER_STATE__',
    'mock-auth.session.v1',
  ];
  const darkHits = [];
  for (const p of plugins) {
    if (p.id === 'sdk') continue; // 契约常量的定义处，天然豁免
    const dir = resolve(pluginsRoot, p.id);
    const walk = (d) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const sub = resolve(d, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === 'dist' || ent.name === 'node_modules') continue;
          walk(sub);
        } else if (/\.(ts|tsx|mjs)$/.test(ent.name)) {
          const text = stripComments(readFileSync(sub, 'utf8'));
          for (const ch of DARK_CHANNELS) {
            if (text.includes(ch)) darkHits.push(`plugins/${p.id}/${relative(pluginsRoot, sub)} → 裸通道字面量 ${ch}`);
          }
        }
      }
    };
    walk(dir);
  }
  if (darkHits.length) {
    fail(`暗通道违规：以下文件绕过 @sdk 契约直接硬编码跨插件通道名（先在 plugins/sdk/index.ts 登记，再 import 使用）：\n      ${darkHits.join('\n      ')}`);
  }
  ok(`暗通道门禁通过：插件源码无裸跨插件字面量（${DARK_CHANNELS.length} 个受保护通道）`);

  // 死能力探测（host-slimming-report §3 闸 3）：provides 在 grants 无任何消费者
  // 授权且宿主无引用 → 警告。面板/管理类能力由用户经 UI 调用,不在此列——
  // 本检查若早两周上线,cap.ui.layout 的 2633 行当时就会被当众质疑（§2.1）。
  const PANEL_CAP_HINTS = ['admin', 'panel', 'ui', 'mode', 'mobile', 'auth'];
  const consumedBy = new Map(); // cap → [consumerIds]
  for (const p of plugins) {
    for (const cap of manifests.get(p.id).capabilities) {
      if (!consumedBy.has(cap)) consumedBy.set(cap, []);
      consumedBy.get(cap).push(p.id);
    }
  }
  const deadCaps = [];
  for (const p of plugins) {
    for (const cap of manifests.get(p.id).provides) {
      const consumers = (consumedBy.get(cap) ?? []).filter((id) => id !== p.id);
      const looksLikePanelCap = PANEL_CAP_HINTS.some((h) => cap.includes(h));
      if (consumers.length === 0 && !looksLikePanelCap) {
        deadCaps.push(`${p.id} provides ${cap}：无任何插件消费（也非面板/管理类），疑似死能力`);
      }
    }
  }
  for (const d of deadCaps) console.warn(`  warn 死能力 ${d}`);
  ok(`死能力探测完成${deadCaps.length ? `（${deadCaps.length} 条疑似死能力，见 warn）` : '：全部 provides 均有插件消费者'}`);

  return manifests;
}

// ============================================================================
// B. 构建 + 产物校验
// ============================================================================
const SECRET_RE = /\bsk-[A-Za-z0-9_-]{20,}/;

function buildOne(p) {
  if (SKIP_BUILD) return;
  process.stdout.write(`  build ${p.id} ... `);
  try {
    execSync(`npx vite build --config ${p.config}`, { cwd: pluginsRoot, stdio: 'inherit' });
  } catch {
    throw new BuildError(`插件 ${p.id} 构建失败（见上方 vite 输出）`);
  }
  console.log('');
}

function publishOne(p) {
  const distDir = resolve(pluginsRoot, p.dist);
  const bundle = resolve(distDir, 'plugin.js');
  if (!existsSync(bundle)) fail(`插件 ${p.id}：产物缺失 ${p.dist}/plugin.js`);
  if (statSync(bundle).size === 0) fail(`插件 ${p.id}：产物 ${p.dist}/plugin.js 为空`);

  const code = readFileSync(bundle, 'utf8');
  const leak = SECRET_RE.exec(code);
  if (leak) fail(`插件 ${p.id}：产物中疑似真实密钥 "${leak[0].slice(0, 12)}…"，已中止发布`);
  if (!code.includes(`"${p.id}"`)) {
    fail(`插件 ${p.id}：产物里找不到字面量 "${p.id}"，可能打包了错误入口（manifest.id 未进入 bundle）`);
  }

  const dest = resolve(hostPublic, p.id);
  mkdirSync(dest, { recursive: true });
  cpSync(distDir, dest, { recursive: true });

  const published = resolve(dest, 'plugin.js');
  if (!existsSync(published) || statSync(published).size !== statSync(bundle).size) {
    fail(`插件 ${p.id}：复制到 public/plugins/${p.id}/ 后大小不一致`);
  }

  // 只有真实存在 CSS 产物时才声明 style，宿主据此决定是否注入 <link>（不再靠 404 + onerror 兜底）
  // 同时对**产物**再过一遍样式门禁：源文件合规不等于打包产物合规（压平、合并可能引入新选择器）
  const styleFile = resolve(distDir, 'style.css');
  const hasStyle = existsSync(styleFile);
  if (hasStyle) {
    const { errors, warnings } = lintPluginCss(readFileSync(styleFile, 'utf8'), `${p.dist}/style.css`);
    if (errors.length) fail(errors.join('\n      '));
    warnings.forEach((w) => console.warn(`  warn ${w}`));
  }
  // 产物内容 hash 作为缓存破坏版本号：bundle 变了 URL 就变，浏览器不再吃旧缓存
  // （dev 曾因磁盘缓存启发式命中旧 bundle，表现为「改了没生效」的假象；prod 静态服务同受益）
  const bundleVersion = createHash('sha256').update(readFileSync(resolve(distDir, 'plugin.js'))).digest('hex').slice(0, 8);
  const manifest = { id: p.id, module: `/plugins/${p.id}/plugin.js?v=${bundleVersion}`, enabled: p.enabled ?? true };
  if (hasStyle) manifest.style = `/plugins/${p.id}/style.css?v=${bundleVersion}`;
  const manifestFile = resolve(dest, 'plugin.json');
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const readBack = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (readBack.id !== p.id || readBack.module !== manifest.module) {
    fail(`插件 ${p.id}：plugin.json 回读不一致`);
  }
  return manifest;
}

// ============================================================================
// C. 收尾：静态资源 + 陈旧目录清理 + registry
// ============================================================================
function publishSharedAssets() {
  const shim = resolve(pluginsRoot, ESM_SHIM);
  if (!existsSync(shim)) fail(`缺少 ESM shim：plugins/${ESM_SHIM}`);
  mkdirSync(hostPublic, { recursive: true });
  cpSync(shim, resolve(hostPublic, ESM_SHIM));
  // 这是插件能否加载的前置条件（import map 指向它）；以前靠手工复制，clean 后会整体崩掉
  ok(`已发布 ${ESM_SHIM}`);
}

function pruneStale() {
  if (!existsSync(hostPublic)) return;
  const keep = new Set(plugins.map((p) => p.id));
  const removed = [];
  for (const name of readdirSync(hostPublic, { withFileTypes: true })) {
    if (!name.isDirectory() || keep.has(name.name)) continue;
    const owner = resolve(hostPublic, name.name, 'plugin.json');
    if (!existsSync(owner)) continue; // 不是构建产物，不动
    rmSync(resolve(hostPublic, name.name), { recursive: true, force: true });
    removed.push(name.name);
  }
  if (removed.length) ok(`清理陈旧插件产物：${removed.join('、')}`);
}

function writeRegistry(entries) {
  const registry = { plugins: entries };
  const file = resolve(hostPublic, 'registry.json');
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);

  // 回读校验：id 唯一 + 每个 module 指向真实文件
  const readBack = JSON.parse(readFileSync(file, 'utf8'));
  const ids = readBack.plugins.map((x) => x.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) fail(`registry.json id 重复：${dup.join('、')}`);
  for (const entry of readBack.plugins) {
    // module 带缓存破坏版本号（?v=hash）：校验文件存在性时剥离 query
    const target = resolve(hostPublic, entry.module.replace(/^\/plugins\//, '').split('?')[0]);
    if (!existsSync(target)) fail(`registry 指向的文件不存在：${entry.module}`);
  }
  ok(`registry.json（${readBack.plugins.length} 个插件）回读校验通过`);
}

// ============================================================================
// main
// ============================================================================
try {
  const manifests = preflight();
  if (CHECK_ONLY) {
    console.log('\n--check：静态校验通过，未构建。');
    process.exit(0);
  }

  console.log(`\n[2/3] ${SKIP_BUILD ? '复用现有产物（--skip-build）' : '构建插件'}`);
  const entries = [];
  for (const p of plugins) {
    buildOne(p);
    const manifest = publishOne(p);
    entries.push(manifest);
    ok(`${p.id} v${manifests.get(p.id).version} -> ${manifest.module}${manifest.style ? ' + style.css' : ''}`);
  }

  console.log('\n[3/3] 收尾');
  publishSharedAssets();
  pruneStale();
  writeRegistry(entries);

  console.log('\n构建完成：public/plugins/');
} catch (err) {
  if (err instanceof BuildError) {
    console.error(`\n✖ 构建中止：${err.message}`);
    process.exit(1);
  }
  throw err;
}
