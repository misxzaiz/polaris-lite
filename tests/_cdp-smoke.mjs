/**
 * 用 CDP 注入会话 cookie 后截图/取 DOM：验证登录后四槽布局与插件面板是否真的渲染。
 * 仅用于本地验收（不进入项目依赖）。
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const SID = process.argv[2];
const TARGET = process.argv[3] ?? 'http://127.0.0.1:9832/';
const OUT = process.argv[4] ?? '/tmp/after-login.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=/tmp/plite-chrome-cdp',
  'about:blank',
], { stdio: 'ignore', detached: false });

let target;
for (let i = 0; i < 40; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (target) break;
  } catch { /* 等 chrome 起来 */ }
  await sleep(250);
}
if (!target) throw new Error('chrome devtools 未就绪');

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? msg.error);
    pending.delete(msg.id);
  } else if (msg.method) {
    events.push(msg);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const send = (method, params = {}) => new Promise((resolve) => {
  const n = ++id;
  pending.set(n, resolve);
  ws.send(JSON.stringify({ id: n, method, params }));
});

await send('Network.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.setCookie', {
  name: 'plite.sid', value: SID, domain: '127.0.0.1', path: '/', httpOnly: true,
});
await send('Page.navigate', { url: TARGET });
await sleep(7000);

const dom = await send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
const text = await send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,1500)', returnByValue: true });
const errors = events
  .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  .map((e) => e.params.entry.text);

writeFileSync(OUT, dom.result.value ?? '');
console.log('--- BODY TEXT ---');
console.log(text.result.value);
console.log('--- CONSOLE ERRORS ---');
console.log(errors.length ? errors.join('\n') : '(none)');
ws.close();
process.exit(0);
