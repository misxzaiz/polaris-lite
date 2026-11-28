/**
 * media-push 单元测试：魔数嗅探（8 kind）、csv/tsv 解析切片、zip 目录树、鉴权与防穿越。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerPart } from '../plugins/media-push/server.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeRes() {
  return {
    chunks: [], statusCode: 0, headers: {}, done: false,
    writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs || {}; },
    on(ev, cb) { this._s = this._s || {}; this._s[ev] = cb; },
    end(c) { if (c) chunksPush(this, c); this.done = true; },
    emit(ev, ...a) { const cb = (this._s || {})[ev]; if (cb) cb(...a); return true; },
    once(ev, cb) { this.on(ev, (...a) => { cb(...a); }); },
    destroy() {},
    json() { try { return JSON.parse(this.chunks.join('') || '{}'); } catch { return {}; } },
  };
}
function chunksPush(res, c) { res.chunks.push(String(c)); }

async function callApi(mw, method, url, body) {
  const listeners = {};
  const req = {
    method, url, headers: { authorization: 'Bearer t' },
    on(ev, cb) { listeners[ev] = cb; },
  };
  const res = makeRes();
  const p = mw(req, res, () => { res.statusCode = 404; res.end(); });
  // 中间件同步注册 data/end 监听后，手工投递 body
  if (listeners.data) {
    const buf = Buffer.from(body ? JSON.stringify(body) : '');
    listeners.data(buf);
  }
  if (listeners.end) listeners.end();
  await p;
  return res;
}

const tmp = mkdtempSync(join(tmpdir(), 'media-push-test-'));
const dataDir = join(tmp, 'data');
const mw = createServerPart({
  dataDir,
  getSession: () => null,
  verifyTempToken: () => true,
  registry: { registerTool: () => {} },
});

function makeMiniZip(names) {
  const local = []; const central = []; let off = 0;
  for (const name of names) {
    const nb = Buffer.from(name);
    const data = Buffer.from('hello');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    local.push(lh, nb, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nb.length, 28);
    cd.writeUInt32LE(off, 42);
    central.push(cd, nb);
    off += 30 + nb.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8); eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cdBuf, eocd]);
}

test('鉴权：无 cookie 且无 Bearer → 401', async () => {
  const mw2 = createServerPart({ dataDir, getSession: () => null, verifyTempToken: () => false, registry: null });
  const res = await callApi(mw2, 'GET', '/api/media/xxx');
  assert.equal(res.statusCode, 401);
});

test('魔数嗅探：伪装扩展名不影响 kind 判定（xlsx 存成 .png 仍为 sheet）', async () => {
  const zip = makeMiniZip(['xl/workbook.xml', '[Content_Types].xml']);
  const src = join(tmp, 'fake.png');
  writeFileSync(src, zip);
  const res = await callApi(mw, 'POST', '/api/media/push', { path: src });
  const j = res.json();
  assert.equal(res.statusCode, 200, JSON.stringify(j));
  assert.equal(j.ok, true);
  assert.equal(j.kind, 'sheet');
  assert.equal(j.ext, 'xlsx');
  assert.match(j.url, /^\/api\/media\/[0-9a-f-]+\.xlsx$/);
});

test('魔数嗅探：各 kind 识别', async () => {
  const cases = [
    { name: 'a.png', buf: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), kind: 'image' },
    { name: 'a.mp4', buf: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(8)]), kind: 'video' },
    { name: 'a.mp3', buf: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]), kind: 'audio' },
    { name: 'a.pdf', buf: Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(64)]), kind: 'pdf' },
    { name: 'a.bin', buf: makeMiniZip(['foo.txt']), kind: 'archive' },
    { name: 'a.csv', buf: Buffer.from('日期,分类,金额,备注\n11-01,餐饮,32,小炒\n11-02,交通,2.4,公交\n'), kind: 'sheet', ext: 'csv' },
    { name: 'a.tsv', buf: Buffer.from('日期\t分类\t金额\na\tb\tc\n'), kind: 'sheet', ext: 'tsv' },
    { name: 'a.txt', buf: Buffer.from('只是一段中文文本，没有多列结构。\n'), kind: 'text' },
    { name: 'a.xyz', buf: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff, 0x00, 0x19, 0x88, 0x77]), kind: 'other' },
  ];
  for (const c of cases) {
    const src = join(tmp, c.name);
    writeFileSync(src, c.buf);
    const res = await callApi(mw, 'POST', '/api/media/push', { path: src });
    const j = res.json();
    assert.equal(j.kind, c.kind, `${c.name} → 期望 ${c.kind}，实际 ${j.kind}（${j.error ?? ''}）`);
    if (c.ext) assert.equal(j.ext, c.ext);
  }
});

test('直出：Content-Type 按落盘扩展名；非白名单文件名拒绝', async () => {
  const src = join(tmp, 'ct.png');
  writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const push = await callApi(mw, 'POST', '/api/media/push', { path: src });
  const j = push.json();
  const get = await callApi(mw, 'GET', j.url);
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers['Content-Type'] ?? get.headers['content-type'], 'image/png');
  const bad = await callApi(mw, 'GET', '/api/media/xxxx.exe');
  assert.ok(bad.statusCode === 400 || bad.statusCode === 404, '非白名单文件名必须被拒绝');
});

test('sheet 切片：排序/筛选/翻页 + limit 上限（不整表下发）', async () => {
  const lines = ['日期,分类,金额'];
  for (let i = 1; i <= 1000; i++) lines.push(`2026-${String(Math.floor(i / 100) + 1).padStart(2, '0')}-01,cat${i % 7},${i},row${i}`);
  const src = join(tmp, 'big.csv');
  writeFileSync(src, lines.join('\n'));
  const push = await callApi(mw, 'POST', '/api/media/push', { path: src });
  const id = push.json().id;

  const p1 = (await callApi(mw, 'GET', `/api/media/${id}/table?offset=0&limit=50`)).json();
  assert.equal(p1.ok, true);
  assert.equal(p1.total, 1000);
  assert.equal(p1.rows.length, 50);

  const s = (await callApi(mw, 'GET', `/api/media/${id}/table?sort=2&dir=desc&limit=5`)).json();
  assert.equal(s.rows[0][2], '1000');

  const f = (await callApi(mw, 'GET', `/api/media/${id}/table?filterCol=1&filter=cat3&limit=500`)).json();
  assert.equal(f.total, 143);
  assert.ok(f.rows.every((r) => r[1] === 'cat3'));

  const cap = (await callApi(mw, 'GET', `/api/media/${id}/table?limit=99999`)).json();
  assert.ok(cap.rows.length <= 500);
});

test('text 切片：截断预览 + 续读', async () => {
  const src = join(tmp, 'long.txt');
  writeFileSync(src, 'x'.repeat(300 * 1024));
  const push = await callApi(mw, 'POST', '/api/media/push', { path: src });
  const id = push.json().id;
  const t = (await callApi(mw, 'GET', `/api/media/${id}/text?limit=1024`)).json();
  assert.equal(t.ok, true);
  assert.equal(t.total, 300 * 1024);
  assert.equal(t.text.length, 1024);
});

test('归档 meta：zip 目录树（前 200 项 + total）', async () => {
  const names = [];
  for (let i = 0; i < 250; i++) names.push(`dir${i % 5}/file${i}.txt`);
  const src = join(tmp, 'many.zip');
  writeFileSync(src, makeMiniZip(names));
  const push = await callApi(mw, 'POST', '/api/media/push', { path: src });
  const id = push.json().id;
  const m = (await callApi(mw, 'GET', `/api/media/${id}/meta`)).json();
  assert.equal(m.ok, true);
  assert.equal(m.kind, 'archive');
  assert.equal(m.totalEntries, 250);
  assert.equal(m.entries.length, 200);
});

test('xlsx 拒绝在线切片（XLSX_NYI）但可下载', async () => {
  const src = join(tmp, 'b.xlsx');
  writeFileSync(src, makeMiniZip(['xl/workbook.xml']));
  const push = await callApi(mw, 'POST', '/api/media/push', { path: src });
  const id = push.json().id;
  const t = (await callApi(mw, 'GET', `/api/media/${id}/table`)).json();
  assert.equal(t.code, 'XLSX_NYI');
});

test('空文件不崩（嗅探兜底 other）', async () => {
  const src = join(tmp, 'empty.xyz');
  writeFileSync(src, Buffer.alloc(0));
  const r = await callApi(mw, 'POST', '/api/media/push', { path: src });
  const j = r.json();
  assert.equal(j.ok, true);
  assert.equal(j.kind, 'other');
});

test('meta 端点：sheet 卡初始化（表头 + 总行数）', async () => {
  const src = join(tmp, 'm.csv');
  writeFileSync(src, '日期,分类,金额\na,b,1\nc,d,2\n');
  const push = await callApi(mw, 'POST', '/api/media/push', { path: src });
  const id = push.json().id;
  const m = (await callApi(mw, 'GET', `/api/media/${id}/meta`)).json();
  assert.deepEqual(m.header, ['日期', '分类', '金额']);
  assert.equal(m.totalRows, 2);
});

process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });
