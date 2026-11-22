/**
 * workspace 迁出守卫（host-slimming-report §7.1 / §4 P2-2;原冻结守卫改档）。
 *
 * 历史：2026-11-19 workspace 布局树 +2633 行进核心（零插件消费者）;11-21 冻结;
 * 同日经所有者决议执行 §7.1 抽出流程——布局树实现迁 plugins/workspace-layout。
 *
 * 本守卫固化迁移完成态：
 * 1. 核心 src/core/workspace/ 只允许契约文件（schema re-export / viewRegistry / 常量）——
 *    任何实现文件回流核心都视为第二次膨胀,直接红;
 * 2. 契约面行数水位（防契约层变成新的堆积区）;
 * 3. 迁移健康监测：布局插件在位且 grants 有布局授权。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wsDir = resolve(root, 'src/core/workspace');

/** 迁出完成态:核心只留契约四文件 */
const CONTRACT_FILES = ['contract.ts', 'layoutCapConstants.ts', 'schema.ts', 'viewRegistry.ts'];
/** 契约水位(schema 事实源 438 + viewRegistry 135 + 常量/聚合;+10% 容差,防契约层变堆积区) */
const CONTRACT_LINE_BUDGET = Math.round(590 * 1.10); // schema 事实源留核心(438)+viewRegistry+常量

test('workspace 迁出：核心目录不得出现实现文件（防第二次膨胀）', () => {
  assert.ok(existsSync(wsDir), '契约目录 src/core/workspace 应存在');
  const actual = readdirSync(wsDir).filter((f) => /\.(ts|tsx)$/.test(f)).sort();
  const impl = actual.filter((f) => !CONTRACT_FILES.includes(f));
  if (impl.length) {
    assert.fail(
      '核心 workspace 目录出现实现文件：' + impl.join('、') + '。' +
      '布局实现归属 plugins/workspace-layout（P2-2 迁出决议）;实现回流核心=第二次膨胀。',
    );
  }
});

test('workspace 契约水位 ≤ ' + CONTRACT_LINE_BUDGET + ' 行（防契约层变堆积区）', () => {
  let total = 0;
  for (const f of CONTRACT_FILES) {
    const p = resolve(wsDir, f);
    if (existsSync(p)) total += readFileSync(p, 'utf8').split('\n').length;
  }
  console.log('  workspace 契约水位：' + total + ' / ' + CONTRACT_LINE_BUDGET);
  assert.ok(
    total <= CONTRACT_LINE_BUDGET,
    '契约层 ' + total + ' 行超水位。契约文件只收类型/常量/校验器声明——实现请进 plugins/workspace-layout。',
  );
});

test('迁移健康：布局插件在位且 grants 持有布局授权', () => {
  const pluginIndex = resolve(root, 'plugins/workspace-layout/index.tsx');
  assert.ok(existsSync(pluginIndex), 'workspace-layout 插件应在位(P2-2 迁出决议)');
  const grants = JSON.parse(readFileSync(resolve(root, 'public/grants.json'), 'utf8'));
  const g = grants.plugins['workspace-layout'];
  assert.ok(g, 'workspace-layout 应在 grants 登记');
  assert.ok(
    (g.provides ?? []).includes('cap.ui.layout'),
    '布局插件应提供 cap.ui.layout(实现归属迁至插件,授权同步)',
  );
  console.log('  workspace 迁出健康：插件在位,布局授权正常');
});
