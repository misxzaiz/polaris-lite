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
 *   2026-11-26 · 服务端执行域注册化（引擎/工具皆插件）：宿主持有通用适配器注册表
 *   server/adapter-registry.mjs（按 id 注册/查找，零引擎/工具知识），引擎与工具插件在
 *   各自 server 半边注册、agent-runner 只查表调用；另 prod-server 增加 NODE_TEST_CONTEXT
 *   守卫（PM2 托管 shell 里跑测试不再抢端口）。CORE_BUDGET 5180 → 5260。
 *   2026-11-26 · 壳层语义补全 + 跨插件存储收口：i18n 字典（src/core/i18n.ts，替换
 *   `t: key => key` 的空实现）、主题色唯一出处（src/core/theme.ts，消除与 tokens 的
 *   三处漂移）、槽位 tab 语义表（slotRegistry 的 SLOT_TABS，替代 `slot === 'panel'`
 *   硬编码）、适配器注册表新增 service 表（跨插件读写的唯一合法通道，替代 agent-runner
 *   直写 chat-store 文件 / 直连 kv-store sqlite）。四者都是「机制/壳层」，不是业务；
 *   业务实现仍在插件里。CORE_BUDGET 5260 → 5345。
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
 *  属壳层布局职责修复，非新功能进核心。
 *  2026-11-26 上调 4915 → 5180：AI 引擎注册化的协议层（src/core/aiEngine.ts 通用注册表
 *  + 分派器、src/core/types.ts 的 aiEngine 契约类型）。核心只认 cap.ai.chat.<id> 命名
 *  约定与 manifest 元数据，不认识任何具体引擎/厂商；引擎实现全在插件里。
 *  不放进插件的原因：总线单注册位 + assertAllowed 精确匹配，插件路由器要么撕开单注册
 *  语义、要么开 cap.ai.chat.* 通配授权，反而扩大特权面。
 *  2026-11-26 上调 5345 → 5390：宿主级伪全屏机制（styles.css +44 行，data-plite-ufs
 *  属性规则 + 抽屉 :has() 让位）。移动端根治：Android WebView 原生全屏退出触发窗口
 *  焦点周期、某 ROM 重放沉浸态（用户实测「退出后又变回全屏」，双击冷却防御无效），
 *  根治 = 弃 requestFullscreen 改 CSS 覆盖层。fixed 锚定必须宿主持有：构建门禁禁
 *  插件 CSS 用 position:fixed，宿主是唯一合法位置；抽屉让位需 :has() 选中宿主元素，
 *  插件侧同理被门禁禁止。属视口/抽屉壳层职责，非业务。
 *  2026-11-26 下调 5390 → 5345：上条豁免的伪全屏机制整体退役——CSS 覆盖层撞层叠
 *  上下文陷阱（.slot 的 z-index:0+isolation:isolate 困住全屏层，顶栏/输入条压顶，
 *  「盖不全 + 对话还能滚」），方案改为浏览器原生 Popover top layer（el.showPopover
 *  提升到一切层叠上下文之上，DOM 原位零重载，四个坑天然免疫），宿主 44 行全删、
 *  布局职责回到插件 CSS（UA 默认样式 + 插件覆盖 margin/inset）。豁免随方案作废
 *  回滚，预算恢复 5345。
 * 2026-11-27 · 顶栏 chrome 外移（topbar 容器契约）：SlotLayout 顶栏渲染权经
 containers 契约委托插件（与 slot-tabs/layout-root 同款机制；宿主保留抽屉状态
 权威 + 内置回退，types.ts 契约 +17、SlotLayout 委托 +18）。业务（会话标题等）
 全在 session-hud 插件里，核心零业务不变。CORE_BUDGET 5345 → 5385。
 * 2026-11-28 · 渲染崩溃加固（P0 审计六层保底的宿主层）：src/core/ErrorBoundary.tsx
 新增（约 +155 行）——根级 app 边界（SlotLayout 崩溃给可读兜底不再白屏）、面板级
 panel 边界（SlotEntryView 统一包裹，单插件面板中毒只降级该面板）、window error/
 unhandledrejection 全局监听（React 边界外的异步错误留底+通知中心 toast，节流）。
 边界必须宿主持有：插件互相不可见、崩溃隔离恰是宿主职责；消息级/工具卡级边界
 留在 chat-lite 插件内（MessageBoundary 已有、CardBoundary 新增）。CORE_BUDGET
 5385 → 5460。
 */
const CORE_BUDGET = 5460;

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
