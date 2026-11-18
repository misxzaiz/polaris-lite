/**
 * 手动验收脚本（不进 npm test）：验证「发送 → 流式 → 排队 → 刷新持久化」全链路。
 * 用法：node tests/_cdp-chat.mjs <plite.sid> <url>
 * 前置：宿主 dev server 已启动；registry.json 里引擎为 mock-engine（离线可跑）或 real-engine（需 key）。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const SID = process.argv[2];
const TARGET = process.argv[3] ?? 'http://127.0.0.1:9832/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/plite-chrome-chat', 'about:blank',
], { stdio: 'ignore' });

let target;
for (let i = 0; i < 40; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch { /* 等 chrome 就绪 */ }
  await sleep(250);
}
if (!target) throw new Error('chrome devtools 未就绪');

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    logs.push(msg.params.entry.text);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const send = (method, params = {}) => new Promise((resolve) => {
  const n = ++id;
  pending.set(n, resolve);
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};

await send('Network.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.setCookie', { name: 'plite.sid', value: SID, domain: '127.0.0.1', path: '/', httpOnly: true });

const typeAndSend = (text) => evaluate(`(() => {
  const ta = document.querySelector('.chat-textarea');
  if (!ta) return 'no-textarea';
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return 'ok';
})()`);

// 1) 首屏（先清掉上次运行留下的会话，保证从干净态开始）
await send('Page.navigate', { url: TARGET });
await sleep(4000);
await evaluate("localStorage.removeItem('chat-lite.sessions.v1'); 'cleared'");
await send('Page.navigate', { url: TARGET });
await sleep(5000);

console.log('[1] 发送第一条：', await typeAndSend('第一条：验证流式渲染'));
await sleep(1200);
console.log('[2] 流式中再发一条（应入队）：', await typeAndSend('第二条：应当排队'));
await sleep(600);
console.log('    队列提示：', await evaluate("document.querySelector('.chat-queue-hint')?.innerText ?? '(无)'"));

// 等流结束（cursor 消失 / 停止按钮消失）
for (let i = 0; i < 60; i += 1) {
  const streaming = await evaluate("!!document.querySelector('.chat-send.stop')");
  if (!streaming) break;
  await sleep(1000);
}
await sleep(1500);
const after = await evaluate("JSON.stringify({bubbles:[...document.querySelectorAll('.chat-bubble')].map(b=>b.innerText.slice(0,24)), queue: document.querySelector('.chat-queue-hint')?.innerText ?? null})");
console.log('[3] 流结束后的气泡与队列：', after);

// 2) 刷新后会话是否还在
await send('Page.navigate', { url: TARGET });
await sleep(5000);
const persisted = await evaluate("JSON.stringify({count: document.querySelectorAll('.chat-bubble').length, first: document.querySelector('.chat-bubble')?.innerText.slice(0,20) ?? null})");
console.log('[4] 刷新后（持久化）：', persisted);

console.log('--- console errors ---');
console.log(logs.length ? logs.join('\n') : '(none)');
ws.close();
process.exit(0);
