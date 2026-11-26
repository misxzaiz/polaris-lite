/**
 * 服务端「核心零业务」边界回归测试。
 *
 * 背景：README 与 plugin-contract.md 宣称「核心零业务、一切皆插件」，但历史上这条
 * 约束只覆盖前端 UI——文件浏览（/api/fs/*）、工具执行（/api/tool/*）等能力一直
 * 写死在 server/ 宿主里，每加一个功能都要改宿主。本测试把约束延伸到服务端：
 *
 *  1. server/ 目录不得出现任何领域端点字符串（领域 = /api/fs/、/api/tool/ 等）；
 *  2. server/host.mjs 不得 import 具体插件实现，只能通过 server-registry 清单装配；
 *  3. 注册表里的每个 server 半边真实存在、导出正确签名；宿主能装配出全部端点；
 *  4. Server 半边只依赖 node:* 内置与自身相对路径（arch.test 已覆盖，这里补注册层）。
 *
 * 这样「新功能是否绕过插件契约直接改宿主」在 npm test 阶段就会被挡下。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from '../server/host.mjs';
import { SERVER_PLUGINS, mergeRuntimeEnabled } from '../plugins/server-registry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = resolve(root, 'server');

/** 领域端点前缀白名单：这些只能出现在 plugins/<id>/server.mjs，不得出现在 server/。
 *  平台层自身允许的端点只有 /api/auth、/api/providers、/api/model-relay（见 host.mjs）。 */
const DOMAIN_ENDPOINTS = [
  '/api/fs/', '/api/tool/', '/api/files-write/',
  '/api/agent/', '/api/preview/', '/api/share/', '/api/kv/',
  '/api/browser/', '/api/mcp/', '/api/skills/', '/api/hooks/',
  '/api/git/', '/api/market/', '/api/phone/', '/api/translate/',
  '/api/voice-radio/', '/api/chat/', '/api/plugin-admin/',
  '/api/compat/', '/api/app-updater/', '/api/codebuddy/',
];
/** 已迁移到插件的领域模块文件名（防止有人重新在 server/ 下建同名文件） */
const DOMAIN_MODULES = ['fs-api.mjs', 'tool-exec.mjs'];

/** 剥离 JS 注释：注释里提到领域端点（如说明凭证用途）属正常文档，不算越界实现 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('server/ 宿主目录不含任何领域端点或领域模块', () => {
  const hits = [];
  for (const file of readdirSync(serverDir)) {
    if (!file.endsWith('.mjs')) continue;
    const text = stripComments(readFileSync(resolve(serverDir, file), 'utf8'));
    for (const ep of DOMAIN_ENDPOINTS) {
      if (text.includes(ep)) hits.push(`${file} → 领域端点 ${ep}`);
    }
    for (const mod of DOMAIN_MODULES) {
      if (text.includes(mod)) hits.push(`${file} → 领域模块 ${mod}`);
    }
  }
  assert.deepEqual(hits, [], `宿主 server/ 出现领域能力（应属插件 server 半边）：\n  ${hits.join('\n  ')}`);
});

test('host.mjs 只经注册表装配领域能力，不直接 import 插件实现', () => {
  const src = readFileSync(resolve(serverDir, 'host.mjs'), 'utf8');
  const imports = [...src.matchAll(/(?:import)[\s\S]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(!/\.\.\/plugins\/[\w-]+\/server/.test(spec), `host.mjs 直接 import 了插件 server 实现：${spec}`);
  }
  assert.ok(imports.includes('../plugins/server-registry.mjs'), 'host.mjs 必须经 server-registry.mjs 装配插件');
});

test('注册表的每个 server 半边存在、签名正确，宿主可装配出领域端点', () => {
  assert.ok(SERVER_PLUGINS.length > 0, '服务端插件注册表为空');
  for (const { id, entry } of SERVER_PLUGINS) {
    const file = resolve(root, 'plugins', entry.replace(/^\.\//, ''));
    assert.ok(existsSync(file), `服务端插件 ${id} 的 server 半边不存在：${entry}`);
    assert.match(readFileSync(file, 'utf8'), /export\s+function\s+createServerPart/, `${id} 未导出 createServerPart`);
  }
  // 真实装配：每个 host 实例拿到独立中间件实例，清单 id 可见
  const dataDir = mkdtempSync(join(tmpdir(), 'plite-boundary-'));
  try {
    const host = createHost({ dataDir });
    const enabled = SERVER_PLUGINS.filter((p) => p.enabled !== false);
    assert.deepEqual(host.serverPlugins, enabled.map((p) => p.id));
    // 平台 + 领域中间件都在链上：3 个平台（auth/providers/relay）+ N 个启用的领域
    assert.equal(host.middlewares.length, 3 + enabled.length);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('服务端工具由各插件自注册：runner 不再硬编码工具表', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plite-tools-'));
  try {
    const host = createHost({ dataDir });
    const names = host.registry.listTools().map((t) => t.name).sort();
    // 每个领域工具由它的宿主插件注册（禁用该插件 → 该工具消失，模型也看不到）。
    for (const expected of [
      'bash', 'files', 'files_write', 'render', 'browser', 'read_skill',
      'interactive', 'ledger', 'translate', 'suggestions', 'transcript', 'phone',
      'market_list', 'market_install', 'market_uninstall',
    ]) {
      assert.ok(names.includes(expected), `工具 ${expected} 未注册（插件 server 半边未装配？）`);
    }
    // mcp_ 前缀适配器（动态工具，不进 listTools 的精确表）
    assert.ok(host.registry.getTool('mcp_server_list'), 'mcp_ 前缀适配器未注册');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('跨插件存储访问经 service 表：不直读写别人的文件 / sqlite', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'plite-svc-'));
  try {
    const host = createHost({ dataDir });
    const services = host.registry.listServices();
    assert.ok(services.includes('chat-store'), 'chat-store 未注册 service');
    assert.ok(services.includes('kv-store'), 'kv-store 未注册 service');

    // chat-store：合并消息（版本递增 / 幂等由服务实现保证，消费方不碰文件布局）
    const chat = host.registry.getService('chat-store');
    const wrote = chat.mergeMessages('s-svc', null, [
      { id: 'u-1', role: 'user', content: '你好', createdAt: Date.now() },
    ]);
    assert.equal(wrote, true);
    const rec = chat.readRecord('s-svc');
    assert.equal(rec.version, 1);
    assert.equal(rec.session.messages.length, 1);
    assert.equal(chat.mergeMessages('s-svc', null, [{ id: 'u-1', role: 'user', content: '你好' }]), false, '重复消息不应空转版本');

    // kv-store：读写与前缀枚举
    const kv = host.registry.getService('kv-store');
    kv.set('demo', 'k', { a: 1 });
    assert.deepEqual(kv.get('demo', 'k'), { a: 1 });
    assert.deepEqual(kv.keysWithPrefix('demo', 'k'), ['k']);
  } finally {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 上 sqlite 句柄可能未释放 */ }
  }
});

test('agent-runner 不再直连别人的存储（chat-store 文件 / kv-store sqlite）', () => {
  const src = readFileSync(resolve(root, 'plugins/agent-runner/server.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(!src.includes('kv-store.db'), 'runner 不应再自己打开 kv-store 的 sqlite');
  assert.ok(!/new DatabaseSync|node:sqlite/.test(src), 'runner 不应再持有 sqlite 句柄');
  assert.ok(!/resolve\([^)]*'chat-store'\)/.test(src), 'runner 不应再拼 chat-store 目录路径');
});

test('运行时 enabled 合并：registry.json 的开关覆盖构建期默认值', () => {
  const base = [
    { id: 'a', enabled: true },
    { id: 'b', enabled: true },
    { id: 'c', enabled: false },
    { id: 'server-only', enabled: true },
  ];
  const merged = mergeRuntimeEnabled(base, [
    { id: 'b', enabled: false }, // 用户面板禁用
    { id: 'c', enabled: true }, // 运行时重新启用（registry.json 是运行时事实源）
  ]);
  const byId = Object.fromEntries(merged.map((p) => [p.id, p.enabled]));
  assert.equal(byId.a, true, '无运行时记录时保留默认值');
  assert.equal(byId.b, false, '运行时禁用应生效');
  assert.equal(byId.c, true, '运行时启用应覆盖默认');
  assert.equal(byId['server-only'], true, '纯服务端插件（registry 无条目）保留默认值');
});
