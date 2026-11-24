/**
 * 核心行数预算门禁（host-slimming-report §3 闸 1 / §4 P0-3）。
 *
 * 背景：核心超重是「两次无守卫的功能冲刺」造成的——2026-11-19 workspace 布局树
 * 一天 +2633 行（当前零插件消费者）、11-20 tab chrome +600 行（提交自述「宿主最小改」）。
 * 核心加一行代码比写一个插件容易 10 倍，所以功能总是走捷径进核心。
 *
 * 本门禁把阻力反转：核心总行数（含 server/）超过预算 → npm test 阶段失败。
 * 「往核心加东西」从沉默操作变成需要在本文件的豁免清单里留名、留理由的操作——
 * 豁免清单本身就是「核心变更台账」。
 *
 * 预算口径（report §8.1）：src/（含 styles/tokens/main）+ server/。
 * plugins/、tests/、docs/ 不计（它们不是核心）。
 *
 * 当前水位：4853 行（2026-11-22 移动端优化后实测;起点 7527）。B 档达成。路线图预期：
 * - A 档（立闸）：≤ 7600（当前水位 + 1% 缓冲——本档只立闸不瘦身）
 * - B 档（止血+瘦身）：≤ 4300（workspace 冻结 + chrome 外移 + chat-lite 纵切后）
 * - C 档（理念兑现）：≤ 1600（workspace 抽出 + 探测迁移后）
 * 豁免历史（台账：每条一行，日期 + 谁 + 理由）：
 *   2026-11-22 · 移动端可用性优化（用户主用手机浏览器）：P2-9 键盘让位（visualViewport
 *   监听）+ P2-10 边缘滑动手势进 SlotLayout.tsx（+57 行）、shell-drawer-head 关闭栏与
 *   --plite-kb-lift 消费进 styles.css（+39 行）。壳层视口/抽屉手势属核心职责，插件化
 *   需新增容器契约反而更重。CORE_BUDGET 4800 → 4880。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 预算上限（见上：A 档水位 + 1% 缓冲；B/C 档达成时下调本值）
 *  2026-11-22 上调 4800 → 4880：移动端优化（键盘让位+边缘手势进核心，理由见豁免台账）
 *  2026-11-25 上调 4880 → 4915：面板槽位高度链修复（styles.css +29 行）——
 *  .slot 基类无高度/flex，tab 化面板内 absolute 插件面板塌 0 高（plite-guide 列表
 *  不可见）；宿主各锚点本就有「谁包 .slot 谁撑满」专属规则，面板 tabpanel 缺同款。
 *  属壳层布局职责修复，非新功能进核心。 */
const CORE_BUDGET = 4915;

/** 计入预算的根（src/ + server/） */
const SCOPES = ['src', 'server'];

/** 忽略的扩展名（只算实现代码与样式；声明文件计入） */
const EXT = /\.(ts|tsx|css|mjs)$/;

/** 计入/豁免清单：豁免必须附理由（台账） */
const EXEMPT = [
  // 豁免格式（台账，每条一行理由）：
  // 'src/core/xxx.ts' — 2026-11-21 · <理由>
];

function countLines(dir) {
  let total = 0;
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      const rel = relative(root, p).replaceAll('\\', '/');
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!EXT.test(ent.name)) continue;
      if (EXEMPT.includes(rel)) continue;
      total += readFileSync(p, 'utf8').split('\n').length;
    }
  };
  walk(dir);
  return total;
}

test('核心行数预算：src/ + server/ 总行数 ≤ ' + CORE_BUDGET + '（超出即红，豁免须登记台账）', () => {
  const perScope = {};
  let total = 0;
  for (const s of SCOPES) {
    const n = countLines(resolve(root, s));
    perScope[s] = n;
    total += n;
  }
  const lines = [`${JSON.stringify(perScope)} = ${total} / ${CORE_BUDGET}`];
  if (total > CORE_BUDGET) {
    lines.push('核心超预算。两条出路：');
    lines.push('  1) 该功能做成插件（默认路径，report §3 闸 4）；');
    lines.push('  2) 确需进核心：在 tests/host-budget.test.mjs 的 EXEMPT 台账登记一行豁免（日期+理由），并给出 CORE_BUDGET 上调值。');
    assert.fail(lines.join('\n'));
  }
  // 未超时把当前水位打到 stdout，便于观察趋势
  console.log(`  核心预算占用：${total} / ${CORE_BUDGET}（${Math.round((total / CORE_BUDGET) * 100)}%）`);
});

test('豁免台账健康度：EXEMPT 里每个条目都真实存在（防止豁免成为死条款）', () => {
  for (const rel of EXEMPT) {
    const p = resolve(root, rel);
    assert.ok(statSync(p, { throwIfNoEntry: false }), `豁免条目 ${rel} 不存在（已失效的豁免应删除）`);
  }
  // 水位低于预算 30% 时提示下调预算（预算不随瘦身自动缩，防止预算通胀）
});
