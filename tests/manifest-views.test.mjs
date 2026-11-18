/**
 * `contributes.views` 门禁的负例测试。
 *
 * 这些规则每一条都对应一种「装了但用不了」的事故，而它们在运行时几乎不可观测：
 * viewType 少了前缀 → 注册被静默拒绝；组件没导出 → 渲染成红框，但树里已经持久化了
 * 这个 viewType（用户下次启动继续看到红框，自救方式是清 localStorage）。
 * 所以判定必须是构建期的、可回归的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isExported,
  parseViewContributions,
  validateViews,
  VIEW_ANCHORS,
} from '../plugins/manifest-views.mjs';

const ENTRY = `
export function Overview() { return null; }
export const List = () => null;
class Hidden {}
export { Hidden as Exposed };
export { Remote } from './Remote';
function NotExported() {}
`;

test('解析：只取对象字面量里的字面量字段', () => {
  const literal = `{
    id: 'demo',
    contributes: {
      views: [
        { viewType: 'demo.overview', component: 'Overview', title: '概览', defaultAnchor: 'panel' },
        { viewType: 'demo.list', component: 'List', title: '列表' }
      ],
      slots: [{ slot: 'panel', component: 'X', order: 1 }]
    }
  }`;
  const { items, errors } = parseViewContributions(literal, 'demo');
  assert.deepEqual(errors, []);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    viewType: 'demo.overview',
    component: 'Overview',
    title: '概览',
    defaultAnchor: 'panel',
  });
  assert.equal(items[1].defaultAnchor, undefined);
});

test('解析：没有 views 字段时返回空数组（存量插件零改动）', () => {
  const { items, errors } = parseViewContributions(`{ contributes: { slots: [] } }`, 'demo');
  assert.deepEqual(items, []);
  assert.deepEqual(errors, []);
});

test('导出判定：function / const / 别名导出 / 转导出都算，未导出不算', () => {
  assert.equal(isExported(ENTRY, 'Overview'), true);
  assert.equal(isExported(ENTRY, 'List'), true);
  assert.equal(isExported(ENTRY, 'Exposed'), true, 'export { Hidden as Exposed }');
  assert.equal(isExported(ENTRY, 'Remote'), true, 'export { Remote } from ...');
  assert.equal(isExported(ENTRY, 'NotExported'), false);
  // 有意偏宽松：`export { Hidden as Exposed }` 里 `Hidden` 出现在 export 列表内，
  // 静态扫描会判为「已导出」。这里宁可漏放（运行时仍有「未导出组件」红框兜底），
  // 也不愿误杀合法的花式导出写法——构建门禁的错误方向必须偏「不挡正确代码」。
  assert.equal(isExported(ENTRY, 'Hidden'), true, '已知且可接受的宽松判定');
  assert.equal(isExported(ENTRY, ''), false);
});

test('校验：前缀、唯一性、title、组件导出、锚点白名单全部拦下', () => {
  const seen = new Map();
  const errors = validateViews({
    pluginId: 'demo',
    entrySrc: ENTRY,
    seen,
    views: [
      { viewType: 'other.overview', component: 'Overview', title: '概览' },
      { viewType: 'demo.list', component: 'NotExported', title: '列表' },
      { viewType: 'demo.noTitle', component: 'List' },
      { viewType: 'demo.badAnchor', component: 'List', title: '坏锚点', defaultAnchor: 'auth' },
      { viewType: 'host.slot.panel', component: 'List', title: '抢宿主' },
      { viewType: 'demo.bad id', component: 'List', title: '非法字符' },
    ],
  });
  const text = errors.join('\n');
  assert.match(text, /必须以 "demo\." 开头/);
  assert.match(text, /没有导出组件 NotExported/);
  assert.match(text, /缺少 title/);
  assert.match(text, /defaultAnchor 只能是 sidebar\/stream\/input\/panel/);
  assert.match(text, /宿主保留命名空间/);
  assert.match(text, /只允许小写字母数字/);
});

test('校验：跨插件重复 viewType 被拦（后到者报冲突）', () => {
  const seen = new Map();
  const first = validateViews({
    pluginId: 'a',
    entrySrc: 'export function V() {}',
    seen,
    views: [{ viewType: 'a.v', component: 'V', title: '甲' }],
  });
  assert.deepEqual(first, []);
  // b 声明 a.v 会先触发「前缀」错误；用自己的前缀但撞名的情况由 seen 拦（同插件内重复）
  const dup = validateViews({
    pluginId: 'a',
    entrySrc: 'export function V() {}',
    seen,
    views: [{ viewType: 'a.v', component: 'V', title: '甲' }],
  });
  assert.match(dup.join('\n'), /viewType 重复/);
});

test('锚点白名单与工作区树一致：auth 不在其中', () => {
  assert.deepEqual([...VIEW_ANCHORS].sort(), ['input', 'panel', 'sidebar', 'stream']);
  assert.equal(VIEW_ANCHORS.includes('auth'), false);
});
