/**
 * 架构边界回归测试：「核心零业务、一切皆插件」不能只写在文档里。
 *
 * 这套约束的失效是**渐进且无声**的：先在核心 import 一个插件常量，再在插件里
 * `@/` 引用宿主 store，最后核心与插件又长回一块，插件独立性名存实亡。
 * 那时候再拆，成本是重做。所以把它做成测试——每次 `npm test` 都会挡住越界。
 *
 * 规则：
 *  1. 插件运行时代码只能依赖自身相对路径、@sdk、react/react-dom、zustand；
 *     不得 import 宿主实现（`@/`、`../src/`、`../../`）或其它插件目录。
 *  2. 宿主核心（src/）不得 import 任何插件路径——核心不认识插件，只认识 @sdk 契约。
 *  3. 源码目录不得出现疑似真实密钥（`sk-` 长串）。产物里的同类检查在构建脚本中。
 *  4. UI 源码不使用 emoji / 彩色符号字符，统一使用可控的 SVG 细线图标。
 *
 * 注：`shared.plugin-config.ts` 被各插件的 vite.config.ts 以 `../shared.plugin-config`
 * 引用，属**构建期**共享配置、不进 bundle，故允许单层向上；`../../` 才是逃逸信号。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODE_RE = /\.(ts|tsx|mjs|js)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
/** vite 加载 vite.config.ts 时会短暂生成 vite.config.ts.timestamp-<digits>.mjs，
 *  构建与测试并发时它可能在 readdir 之后被删掉 → ENOENT 假红。统一排除这类临时文件。 */
const TEMP_RE = /\.timestamp-\d+\./;

/** 递归收集源码文件（相对 root 的 posix 路径） */
function collect(relDir) {
  const abs = resolve(root, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { recursive: true })
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => CODE_RE.test(p))
    .filter((p) => !TEMP_RE.test(p))
    .filter((p) => !p.split('/').some((seg) => SKIP_DIRS.has(seg)))
    .map((p) => posix.join(relDir.replace(/\\/g, '/'), p));
}

/** 提取文件里所有静态/动态 import 的模块说明符 */
function specifiers(code) {
  const out = [];
  for (const m of code.matchAll(/(?:^|\s)(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

/** 构建期文件：由 Node/vite 执行，依赖 node:* 与构建工具是正常的，不参与运行时依赖约束 */
const BUILD_TIME = new Set(['plugins/build-plugins.mjs', 'plugins/shared.plugin-config.ts']);

/** 插件间共享的纯前端工具目录：随引用方 bundle 打包（非插件、无宿主依赖），等同 @sdk 的豁免待遇 */
const isSharedUtil = (spec) => spec.startsWith('../shared/');

const pluginFiles = collect('plugins').filter(
  (p) => !p.startsWith('plugins/sdk/') && !BUILD_TIME.has(p) && !p.endsWith('/vite.config.ts'),
);
const coreFiles = collect('src');

/** 插件 CSS 不受 CODE_RE 覆盖，单独收集（含 dist 之外的源样式） */
const pluginCssFiles = readdirSync(resolve(root, 'plugins'), { recursive: true })
  .map((p) => p.replace(/\\/g, '/'))
  .filter((p) => !TEMP_RE.test(p))
  .filter((p) => p.endsWith('.css'))
  .filter((p) => !p.split('/').some((seg) => SKIP_DIRS.has(seg)))
  .map((p) => posix.join('plugins', p));

test('插件不得依赖宿主实现或其它插件', () => {
  assert.ok(pluginFiles.length > 0, '未找到插件源码，路径推导可能有误');
  const violations = [];
  for (const file of pluginFiles) {
    const ownPlugin = file.split('/')[1];
    for (const spec of specifiers(readFileSync(resolve(root, file), 'utf8'))) {
      // 宿主实现泄漏：别名 @/、显式 src/、以及跳出 plugins/ 的两级相对路径
      if (/^@\//.test(spec) || /(^|\/)src\//.test(spec) || spec.startsWith('../../')) {
        violations.push(`${file} → ${spec}（引用了宿主实现）`);
        continue;
      }
      // 平级插件互相 import：会绕过 cap 总线与授权表，直接耦合（plugins/shared/ 是共享工具目录，豁免）
      const sibling = /^\.\.\/([\w-]+)\//.exec(spec);
      if (sibling && sibling[1] !== 'sdk' && sibling[1] !== ownPlugin && sibling[1] !== 'shared.plugin-config.ts' && !isSharedUtil(spec)) {
        violations.push(`${file} → ${spec}（引用了其它插件）`);
      }
    }
  }
  assert.deepEqual(violations, [], `插件越界引用：\n  ${violations.join('\n  ')}`);
});

test('宿主核心不得依赖任何插件', () => {
  const violations = [];
  for (const file of coreFiles) {
    for (const spec of specifiers(readFileSync(resolve(root, file), 'utf8'))) {
      if (/(^|\/)plugins\//.test(spec) || /^@sdk/.test(spec)) {
        violations.push(`${file} → ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, [], `核心引用了插件层（核心应只认 cap 与 @sdk 契约）：\n  ${violations.join('\n  ')}`);
});

test('插件只允许依赖声明过的外部包', () => {
  const ALLOWED = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'zustand', '@sdk']);
  const violations = [];
  for (const file of pluginFiles) {
    // server 半边跑在 Node 而非浏览器：node:* 内置模块是平台能力，不需要进 import map。
    // 它仍受上面两条约束（不得引用宿主实现 / 其它插件）——这里只放开内置模块。
    const isServerHalf = /(^|\/)server\.mjs$/.test(file);
    for (const spec of specifiers(readFileSync(resolve(root, file), 'utf8'))) {
      if (spec.startsWith('.') || spec.startsWith('/')) continue; // 自身相对/绝对
      if (isServerHalf && spec.startsWith('node:')) continue;
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!ALLOWED.has(pkg) && !ALLOWED.has(spec)) violations.push(`${file} → ${spec}`);
    }
  }
  assert.deepEqual(violations, [], `插件引入了未声明依赖（需同步 external 与 import map）：\n  ${violations.join('\n  ')}`);
});

test('源码目录不含疑似真实密钥', () => {
  const hits = [];
  for (const dir of ['src', 'plugins', 'server', 'tests']) {
    for (const file of collect(dir)) {
      const m = /\bsk-[A-Za-z0-9_-]{20,}/.exec(readFileSync(resolve(root, file), 'utf8'));
      if (m) hits.push(`${file} → ${m[0].slice(0, 12)}…`);
    }
  }
  assert.deepEqual(hits, [], `疑似密钥入库：\n  ${hits.join('\n  ')}`);
});

test('UI 源码不使用 emoji 或彩色符号图标', () => {
  const hits = [];
  const iconChar = /[\p{Extended_Pictographic}\u2600-\u27BF]/u;
  for (const file of [...coreFiles, ...pluginFiles]) {
    const lines = readFileSync(resolve(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (iconChar.test(line)) hits.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(hits, [], `请使用统一 SVG 细线图标，而非 emoji / 符号字符：\n  ${hits.join('\n  ')}`);
});

test('插件 CSS 不得触碰宿主命名空间或全局根', () => {
  // 权威实现在 plugins/build-plugins.mjs 的 lintPluginCss（构建期 fail-fast）；
  // 这里做测试层快速回归，保证单独跑 `npm test` 也能挡住样式逃逸。
  const rules = [
    { re: /(^|[\s,{}]):root\b/, msg: ':root' },
    { re: /(^|[\s,{}])html\b(?![\w-])/, msg: 'html' },
    { re: /(^|[\s,{}])body\b(?![\w-])/, msg: 'body' },
    { re: /#root\b/, msg: '#root' },
    { re: /@import\b/, msg: '@import' },
    { re: /\.(slot|shell)[\w-]*/, msg: '宿主类名 .slot-* / .shell-*' },
    { re: /position\s*:\s*fixed/, msg: 'position: fixed' },
  ];
  const hits = [];
  for (const file of pluginCssFiles) {
    const css = readFileSync(resolve(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of rules) {
      if (rule.re.test(css)) hits.push(`${file} → ${rule.msg}`);
    }
  }
  assert.deepEqual(hits, [], `插件 CSS 越界（插件样式是全局注入，会污染宿主）：\n  ${hits.join('\n  ')}`);
});
