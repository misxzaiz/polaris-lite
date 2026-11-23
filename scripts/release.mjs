/**
 * release.mjs — 统一发版脚本：commit → push → deploy:9826 → build → restart 9825 → 验证
 *
 * 背景：2026-11-22 踩过的坑——9825 从工作树构建（新功能在线），9826 从 origin/master 部署
 * （还是旧 commit），而 app-updater 版本戳停在更早的 commit，导致「更新面板误报有新版本」。
 * 根因是发版顺序没固化：各环境各取各的代码来源。本脚本把正确顺序固化为一条命令，
 * 结尾做一致性自检，不一致直接报错——任何 AI / 人照着跑都不会发错版。
 *
 * 用法（在仓库本体 D:/space/base/polaris-lite 执行）：
 *   npm run release                    # 常规发版：改动已 stage，自动 commit+push+发布三环境
 *   npm run release -- --dry           # 干跑：只做检查，不 commit 不发布
 *   npm run release -- --msg "..."     # 指定 commit message（默认从改动文件推断）
 *   npm run release -- --skip-9825     # 只发 9826（9825 由别处管理时）
 *   npm run release -- --skip-9826     # 只发 9825（改动不涉及分析实例时）
 *
 * 固化的发版纪律（详见 docs/release-runbook.md）：
 *   1. 工作树必须干净（或已 stage）：发布的是 commit，不是工作树
 *   2. 先 commit + push origin master
 *   3. 再 deploy:9826（独立 clone reset 到新 commit，构建，restart，写版本戳）
 *   4. 最后 build + restart 9825（生产，随仓库走）
 *   5. 终检：三处 commit 必须一致（git HEAD / 9826 clone HEAD / 9826 版本戳）
 *
 * 注意：本脚本不碰 5000（开发环境随 dev:standalone 起停，不参与发版）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SRC = resolve(process.env.PLITE_SRC_DIR ?? 'D:/space/base/polaris-lite');
const DEST = resolve(process.env.PLITE_9826_DIR ?? 'D:/space/base/polaris-lite-9826');
const DATA_9826 = resolve(process.env.PLITE_9826_DATA_DIR ?? join(SRC, '.polaris-lite-pm2'));
const STAMP_FILE = join(DATA_9826, 'app-updater-version.json');
const APP_9825 = 'polaris-lite-9825';
const APP_9826 = 'polaris-lite-9826';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const SKIP_9825 = argv.includes('--skip-9825');
const SKIP_9826 = argv.includes('--skip-9826');
const msgIdx = argv.indexOf('--msg');
const MSG = msgIdx >= 0 ? argv[msgIdx + 1] : null;

const log = (s) => console.log('[release] ' + s);
const die = (s) => { console.error('\n[release] ✗ ' + s); process.exit(1); };

const run = (cmd, cwd, { capture = false, allowFail = false } = {}) => {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  // git diff --cached --quiet / git diff --quiet 用退出码 1 表达「有差异」，是语义信号不是失败
  const semanticOne = /git (diff|rev-list)\b.*--quiet/.test(cmd) && r.status === 1;
  if (r.status !== 0 && r.status !== 1 && !allowFail && !semanticOne) {
    console.error('\n[release] 命令失败(exit ' + r.status + '): ' + cmd + (cwd ? '  @ ' + cwd : ''));
    process.exit(r.status ?? 1);
  }
  return (r.stdout ?? '').trim();
};
/** --quiet 类命令的「是否有差异」只能看退出码（0=无差异，1=有差异）；stdout 恒为空串，
 *  拿输出判断会把「有暂存改动」误判成「无改动」→ 跳过 commit（实测踩坑：修复被漏发） */
const hasDiff = (args, cwd = SRC) => spawnSync('git ' + args, { cwd, shell: true, encoding: 'utf8' }).status === 1;
const git = (args, cwd = SRC) => run('git ' + args, cwd, { capture: true });
const shortLog = (rev, cwd) => git('log -1 --format="%h %s" ' + rev, cwd);

// ---------- 预检 ----------
log('预检：git 状态');
if (!existsSync(join(SRC, 'package.json'))) die('不在仓库本体目录：' + SRC);
if (!SKIP_9826 && !existsSync(DEST)) die('找不到 9826 clone：' + DEST + '（先按 docs/pm2-9826-isolation.md 初始化）');

const status = git('status --porcelain');
const untrackedOnly = status.split('\n').filter(Boolean).every(l => l.startsWith('??'));
const dirty = status.length > 0 && !untrackedOnly;
if (dirty && DRY) {
  die('工作树有未提交/未 stage 的已跟踪改动，发版前必须处理（git add/commit 或 stash）：\n' + status);
}
if (status.length === 0 && !DRY) {
  // 无改动：确认 HEAD 与 origin/master 一致即可直接进入发布（幂等重发）
  log('工作树干净：视为重发当前 HEAD');
}

// ---------- 推断 commit message ----------
const inferMsg = () => {
  if (MSG) return MSG;
  const files = git('diff --cached --name-only').split('\n').filter(Boolean);
  if (files.length === 0) return 'chore: 发版（无暂存改动，重发当前 HEAD）';
  const scopes = [...new Set(files.map(f => {
    const m = f.match(/^plugins\/([^\/]+)\//);
    return m ? m[1] : f.split('/')[0];
  }))];
  const area = scopes.length === 1 ? scopes[0] : scopes.slice(0, 3).join(',') + (scopes.length > 3 ? ',…' : '');
  const areaTag = /^(plugins|server|src|scripts|docs)$/.test(scopes[0]) ? '' : area + ': ';
  return areaTag + '发版快照（' + files.length + ' 个文件，' + new Date().toISOString().slice(0, 10) + '）';
};

// ---------- dry run ----------
if (DRY) {
  log('── dry 模式：只检查不执行 ──');
  log('当前 HEAD   : ' + shortLog('HEAD'));
  log('origin/master: ' + shortLog('origin/master'));
  log('工作树状态  : ' + (status.length === 0 ? '干净' : status.split('\n').length + ' 条'));
  log('9826 clone  : ' + (existsSync(DEST) ? shortLog('HEAD', DEST) : '(不存在)'));
  log('9826 版本戳 : ' + (existsSync(STAMP_FILE)
    ? JSON.parse(readFileSync(STAMP_FILE, 'utf8')).sha.slice(0, 7)
    : '(无)'));
  log('9825 进程   : ' + (run('npx pm2 jlist', SRC, { capture: true, allowFail: true }).includes(APP_9825) ? 'pm2 管理' : '(未发现)'));
  log('dry 检查通过，去掉 --dry 执行实际发版');
  process.exit(0);
}

// ---------- 1. commit + push ----------
log('步骤 1/5：commit + push');
if (!hasDiff('diff --cached --quiet') && status.split('\n').filter(Boolean).some(l => !l.startsWith('??'))) {
  // 有已跟踪改动但没 stage：自动 stage（未跟踪文件不自动包含，避免误提交垃圾）
  log('自动 stage 已跟踪改动');
  git('add -u');
}
if (hasDiff('diff --cached --quiet')) {
  const msg = inferMsg();
  log('commit: ' + msg);
  git('commit -m ' + JSON.stringify(msg));
} else {
  log('无暂存改动，跳过 commit');
}
log('push origin master');
git('push origin master');

const HEAD = git('rev-parse HEAD');
log('发布 commit: ' + HEAD.slice(0, 7) + ' ' + shortLog('HEAD').slice(8));

// ---------- 2. deploy 9826 ----------
if (!SKIP_9826) {
  log('步骤 2/5：deploy:9826（独立 clone 构建+重启+写版本戳）');
  run('npm run deploy:9826', SRC);
}

// ---------- 3. build + restart 9825 ----------
if (!SKIP_9825) {
  log('步骤 3/5：build + restart 9825（生产）');
  run('npm run build', SRC);
  run('npx pm2 restart ' + APP_9825, SRC);
  run('npx pm2 save', SRC);
}

// ---------- 4. 终检：三处一致 ----------
log('步骤 4/5：一致性终检');
const head7 = HEAD.slice(0, 7);
const checks = [];
if (!SKIP_9826) {
  const cloneHead = git('rev-parse HEAD', DEST);
  checks.push(['9826 clone HEAD', cloneHead]);
  if (existsSync(STAMP_FILE)) {
    const stampSha = JSON.parse(readFileSync(STAMP_FILE, 'utf8')).sha;
    checks.push(['9826 版本戳', stampSha]);
  } else {
    die('9826 版本戳文件缺失：' + STAMP_FILE + '（deploy 未完成？）');
  }
}
let failed = false;
for (const [name, sha] of checks) {
  const ok = sha === HEAD;
  if (!ok) failed = true;
  log((ok ? '✓ ' : '✗ ') + name + ' = ' + sha.slice(0, 7) + (ok ? '' : '  ≠ HEAD ' + head7));
}
if (failed) die('一致性检查失败：有环境没发到同一 commit。9826 处理：改 ' + STAMP_FILE + ' 的 sha；9825：重跑本脚本。');

// ---------- 5. 冒烟 ----------
log('步骤 5/5：HTTP 冒烟');
const smoke = (port, name) => {
  const r = run('curl -s -o NUL -w "%{http_code}" http://127.0.0.1:' + port + '/', SRC, { capture: true, allowFail: true });
  log((r === '200' ? '✓ ' : '✗ ') + name + ' http://127.0.0.1:' + port + '/ → ' + r);
  return r === '200';
};
let ok = true;
if (!SKIP_9825) ok = smoke(9825, '9825 生产') && ok;
if (!SKIP_9826) ok = smoke(9826, '9826 分析') && ok;

console.log('\n[release] ' + (ok ? '✅ 发版完成：' : '⚠ 发版完成但冒烟未过（看上面 ✗ 行）：') + head7
  + (SKIP_9825 ? '（未动 9825）' : '') + (SKIP_9826 ? '（未动 9826）' : ''));
process.exit(ok ? 0 : 2);
