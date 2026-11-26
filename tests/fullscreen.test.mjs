/**
 * 伪全屏（Popover top layer）单元测试：钉死 finalize 的回归契约。
 *
 * 背景：fullscreen.ts 的 finalize 曾只调 hidePopover 不摘 popover 属性——
 * 属性残留令 UA 对 [popover] 关闭态的默认样式（position:fixed + inset:0 +
 * fit-content）继续命中，而其中本应隐身的 display:none 被插件作者样式
 * .hp-card{display:flex} 反杀（UA 源永远输作者源），卡片以「悬浮面板」
 * 漂在视口上（2026-11-26 实测坑）。本测试确保属性一定被摘除。
 *
 * 桩策略：fullscreen.ts 是浏览器模块（window/history/popover API），
 * Node 环境用最小桩注入全局，验证模块协议：enter 挂属性+showPopover+压栈，
 * exit（含 Esc/popstate 路径）后属性必须为空、hidePopover 被调、
 * 历史栈不再含全屏 state。不起浏览器——UA 层叠行为不在此覆盖范围。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** 装最小浏览器桩：记录 popover 属性操作与 history 行为 */
function setupStubs() {
  const calls = { show: [], hide: [], back: 0 };
  let stateStack = [null];
  const fakeWindow = {
    addEventListener: () => {},
  };
  globalThis.window = fakeWindow;
  globalThis.history = {
    get state() { return stateStack[stateStack.length - 1]; },
    pushState: (st) => { stateStack.push(st); },
    back: () => { calls.back += 1; stateStack.pop(); onPop(); },
  };
  let onPop = () => {};
  globalThis.history.__setPopHandler = (fn) => { onPop = fn; };
  // popstate 监听在模块加载时挂到 window 上——桩 window 收下 handler 备用
  fakeWindow.addEventListener = (ev, fn) => { if (ev === 'popstate') onPop = fn; };
  return {
    calls,
    /** 造一个带 popover API 的假元素 */
    makeEl: () => {
      const attrs = {};
      return {
        setAttribute: (k, v) => { attrs[k] = v; },
        removeAttribute: (k) => { delete attrs[k]; },
        getAttribute: (k) => attrs[k] ?? null,
        showPopover() { calls.show.push(this); },
        hidePopover() { calls.hide.push(this); },
        matches: () => false,
      };
    },
    cleanup: () => { delete globalThis.window; delete globalThis.history; },
  };
}

test('exit 后 popover 属性必须摘除（悬浮面板回归坑）', async () => {
  const stubs = setupStubs();
  try {
    const mod = await import('../plugins/html-preview/fullscreen.ts');
    const el = stubs.makeEl();
    mod.enterPseudoFullscreen(el);
    assert.equal(el.getAttribute('popover'), 'manual');
    assert.equal(stubs.calls.show.length, 1);

    mod.exitPseudoFullscreen();
    // 核心断言：属性残留 = UA [popover] 关闭态样式命中 = 悬浮面板复现
    assert.equal(el.getAttribute('popover'), null, '退出后 popover 属性必须被摘除');
    assert.ok(stubs.calls.hide.length >= 1, 'hidePopover 应被调用');
    // 历史栈顶不应再含全屏 state（exit 走 back 弹栈路径）
    assert.ok(!(globalThis.history.state && globalThis.history.state.pliteUfs));
  } finally {
    stubs.cleanup();
  }
});

test('finalize 幂等：无 activeEl 时 exit 是 no-op', async () => {
  const stubs = setupStubs();
  try {
    const mod = await import('../plugins/html-preview/fullscreen.ts');
    // 未进入全屏直接 exit —— 不应抛异常
    mod.exitPseudoFullscreen();
    assert.equal(stubs.calls.hide.length, 0);
  } finally {
    stubs.cleanup();
  }
});
