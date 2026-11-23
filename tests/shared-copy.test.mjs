/**
 * copyText 共享工具单测：mock 掉 clipboard / execCommand 验证三条路径与反馈口径。
 * （node:test + strip-types，与 markdown.test.mjs 同款轻量做法）
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// —— 极简 DOM stub：copyText 只用到 document.createElement/body.appendChild/remove ——
class FakeTextarea {
  constructor() {
    this.value = '';
    this.style = {};
    this.dataset = {};
    this.parentElement = null;
  }
  setAttribute() {}
  select() { this.selected = true; }
  setSelectionRange() {}
  remove() { this.removed = true; if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this); }
}
const dom = {
  created: [],
  children: [],
  execCommandResult: true,
  execCommandCalls: [],
  createElement(tag) {
    if (tag !== 'textarea') throw new Error(`unexpected tag ${tag}`);
    const el = new FakeTextarea();
    this.created.push(el);
    return el;
  },
  body: {
    appendChild(el) { el.parentElement = dom; dom.children.push(el); },
  },
  execCommand(cmd) { dom.execCommandCalls.push(cmd); return dom.execCommandResult; },
};

let clipboardState; // 'ok' | 'throw' | 'missing'

globalThis.document = dom;
// Node 24 的 globalThis.navigator 只有 getter，用 defineProperty 覆写
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get() {
    if (clipboardState === 'missing') return { clipboard: undefined };
    return {
      clipboard: {
        writeText: async () => { if (clipboardState === 'throw') throw new Error('NotAllowedError'); return; },
      },
    };
  },
});

const { copyText, legacyCopy } = await import('../plugins/shared/copyText.ts');

describe('copyText（共享复制工具）', () => {
  beforeEach(() => {
    dom.created.length = 0;
    dom.children.length = 0;
    dom.execCommandCalls.length = 0;
    dom.execCommandResult = true;
    clipboardState = 'ok';
  });

  afterEach(() => { clipboardState = 'missing'; });

  test('clipboard API 可用：直接写成功，不碰 execCommand', async () => {
    clipboardState = 'ok';
    assert.equal(await copyText('hello'), true);
    assert.equal(dom.execCommandCalls.length, 0);
  });

  test('clipboard API 抛错：回退 execCommand 且成功', async () => {
    clipboardState = 'throw';
    assert.equal(await copyText('hello'), true);
    assert.deepEqual(dom.execCommandCalls, ['copy']);
    assert.equal(dom.created.length, 1);
    assert.equal(dom.children.length, 0); // 兜底后 textarea 已 remove
    assert.equal(dom.created[0].removed, true);
  });

  test('clipboard API 缺失（Android WebView）：回退 execCommand', async () => {
    clipboardState = 'missing';
    assert.equal(await copyText('hello'), true);
    assert.deepEqual(dom.execCommandCalls, ['copy']);
  });

  test('两条路径都失败：返回 false（调用方必须显示失败而非「已复制」）', async () => {
    clipboardState = 'throw';
    dom.execCommandResult = false;
    assert.equal(await copyText('hello'), false);
  });

  test('空文本直接拒绝', async () => {
    assert.equal(await copyText(''), false);
    assert.equal(dom.execCommandCalls.length, 0);
  });

  test('legacyCopy：textarea 脱离布局流（fixed + opacity 0 + readonly）', () => {
    clipboardState = 'missing';
    assert.equal(legacyCopy('abc'), true);
    const ta = dom.created[0];
    assert.equal(ta.style.position, 'fixed');
    assert.equal(ta.style.opacity, '0');
    assert.equal(ta.style.width, '1px');
    assert.equal(ta.selected, true);
  });
});
