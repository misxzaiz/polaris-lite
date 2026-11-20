/**
 * 构建脚本回归测试：`build-plugins.mjs` 的静态校验必须是**门禁**而不是装饰。
 *
 * 这个脚本以前只做「构建 + 拼接」，问题是全推迟到运行时才暴露：
 * 漏登记 grants → 插件权限被静默收紧；manifest.id 与目录名不一致 → 产物挂错路径；
 * 忘复制 esm-shim.mjs → import map 404、所有插件一起崩（而 public/plugins 是 gitignore 的）。
 * 所以这里锁三件事：静态校验必须通过、注册表必须自洽、esm-shim 必须随产物发布。
 *
 * 注册表相关断言在「尚未构建」时跳过（全新克隆跑 `npm test` 不该因缺产物而红），
 * 一旦产物存在就严格校验——恰好覆盖「CI 先 build 再 test」的顺序。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostPublic = resolve(root, 'public/plugins');
const registryFile = resolve(hostPublic, 'registry.json');
const built = existsSync(registryFile);

test('插件静态一致性校验通过（manifest ∩ grants ∩ requires）', () => {
  // --check 只读源码与 grants.json，不构建；失败时抛出并带上子进程 stderr
  const out = execFileSync(process.execPath, ['plugins/build-plugins.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.match(out, /静态校验通过/);
});

test('registry 条目自洽：id 唯一、module/style 指向真实文件', { skip: !built && '尚未构建 public/plugins' }, () => {
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  const ids = registry.plugins.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'registry id 重复');

  for (const entry of registry.plugins) {
    for (const field of ['module', 'style']) {
      const url = entry[field];
      if (!url) continue;
      assert.ok(url.startsWith(`/plugins/${entry.id}/`), `${entry.id}.${field} 未指向自身目录：${url}`);
      // module/style URL 带缓存破坏版本号（?v=内容hash），校验文件存在性时剥离 query
      const file = resolve(hostPublic, url.replace(/^\/plugins\//, '').split('?')[0]);
      assert.ok(existsSync(file), `${entry.id}.${field} 指向的文件不存在：${url}`);
      assert.ok(statSync(file).size > 0, `${entry.id}.${field} 是空文件：${url}`);
    }
    assert.equal(typeof entry.enabled, 'boolean', `${entry.id}.enabled 必须是显式布尔值`);
  }
});

test('esm-shim.mjs 随产物发布（否则 import map 404，全部插件加载失败）', { skip: !built && '尚未构建 public/plugins' }, () => {
  const shim = resolve(hostPublic, 'esm-shim.mjs');
  assert.ok(existsSync(shim), 'public/plugins/esm-shim.mjs 缺失：lib 产物只有裸 import，没有它插件全部无法装配');
  assert.match(readFileSync(shim, 'utf8'), /export/, 'shim 未导出任何成员');
});

test('只有真正产出样式时才登记 style 字段', { skip: !built && '尚未构建 public/plugins' }, () => {
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  for (const entry of registry.plugins) {
    const css = resolve(hostPublic, entry.id, 'style.css');
    if (entry.style) assert.ok(existsSync(css), `${entry.id} 登记了 style 但 style.css 不存在`);
    else assert.ok(!existsSync(css), `${entry.id} 有 style.css 却未登记，宿主不会注入样式`);
  }
});
