#!/usr/bin/env node
/**
 * build-plugins.mjs：构建全部外部插件并生成宿主可拉取的注册表。
 *
 * 外部注册机制：插件与宿主零源码耦合——
 * - 插件各自独立构建为 ESM bundle（react 外部化，由宿主 import map 提供）；
 * - 产物连同 plugin 清单复制到宿主 public/plugins/<id>/；
 * - 生成 public/plugins/registry.json，宿主启动时 fetch + 动态 import。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginsRoot = dirname(fileURLToPath(import.meta.url));
const hostPublic = resolve(pluginsRoot, '../public/plugins');

const plugins = [
  // order 只决定 registry 的书写顺序与产物列表；**装配顺序由 manifest.requires 拓扑排序决定**
  // （宿主在启动时按「能力提供方先装配」排序），不再依赖这里的先后。
  // mock-engine：验收/演示用途，默认停用（enabled:false）；启用会与 real-engine 抢注 cap.ai.chat。
  { id: 'config-manager', config: 'config-manager/vite.config.ts', dist: 'config-manager/dist', order: 1 },
  { id: 'chat-lite', config: 'chat-lite/vite.config.ts', dist: 'chat-lite/dist', order: 2 },
  { id: 'model-admin', config: 'model-admin/vite.config.ts', dist: 'model-admin/dist', order: 3 },
  { id: 'real-engine', config: 'real-engine/vite.config.ts', dist: 'real-engine/dist', order: 4 },
  { id: 'cap-panel', config: 'cap-panel/vite.config.ts', dist: 'cap-panel/dist', order: 5 },
  { id: 'mock-auth', config: 'mock-auth/vite.config.ts', dist: 'mock-auth/dist', order: 6 },
  // mock-engine：验收/演示用途，默认停用（enabled:false）；启用会与 real-engine 抢注 cap.ai.chat
  { id: 'mock-engine', config: 'mock-engine/vite.config.ts', dist: 'mock-engine/dist', order: 7, enabled: false },
];
plugins.sort((a, b) => a.order - b.order);

const registry = { plugins: [] };

for (const p of plugins) {
  process.stdout.write(`building ${p.id} ... `);
  execSync(`npx vite build --config ${p.config}`, { cwd: pluginsRoot, stdio: 'inherit' });
  const dest = resolve(hostPublic, p.id);
  mkdirSync(dest, { recursive: true });
  cpSync(resolve(pluginsRoot, p.dist), dest, { recursive: true });

  // 每个插件的静态清单（与源码 manifest.id 一致，宿主运行时还会二次校验）
  const manifest = { id: p.id, module: `/plugins/${p.id}/plugin.js`, enabled: p.enabled ?? true };
  writeFileSync(resolve(dest, 'plugin.json'), JSON.stringify(manifest, null, 2));
  registry.plugins.push(manifest);
  console.log(`ok -> public/plugins/${p.id}/plugin.js`);
}

writeFileSync(resolve(hostPublic, 'registry.json'), JSON.stringify(registry, null, 2));
console.log(`registry -> public/plugins/registry.json (${registry.plugins.length} plugins)`);
