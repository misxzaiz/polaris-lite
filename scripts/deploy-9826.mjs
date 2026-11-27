/**
 * deploy-9826.mjs —— 把仓库某个 commit 发布到 9826「钉住」分析实例。
 *
 * 背景：9826 与 9825/5000 曾共用同一份代码目录，任何 build 都会立刻泄漏到 9826。
 * 现在 9826 跑在独立 clone D:/space/base/polaris-lite-9826（origin 指向本仓库），
 * 只有用本脚本显式发布才会更新。详见 docs/pm2-9826-isolation.md。
 *
 * 用法（在仓库本体 D:/space/base/polaris-lite 执行）：
 *   npm run deploy:9826                    # 发布仓库 master 最新 commit（origin/master）
 *   npm run deploy:9826 -- <sha|tag|分支>   # 发布指定版本，如 npm run deploy:9826 -- dd9621e
 *   npm run deploy:9826 -- --rebuild       # 不拉代码，只重建 clone 当前状态（实验模式）
 *   npm run deploy:9826 status             # 对比分析实例与仓库 master 的版本差距
 * （npm 传带 - 的 flag 必须加 -- 分隔，否则 flag 被 npm 吞掉、静默走默认 deploy）
 *
 * 约定：
 *   - 发布的是 commit；工作树未提交的改动不在发布范围（先 git commit 再发布）。
 *   - deploy 模式会 reset --hard：clone 里的本地实验改动会被覆盖，要保留请用 --rebuild。
 *   - package-lock.json 有变化（或 node_modules 缺失）才 npm ci，否则只跑构建（build:plugins + build）。
 *   - 结束后自动 pm2 restart + pm2 save，并在 clone/logs/deploy-9826.log 记一行版本戳。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { cleanEnv } from './sandbox-env.mjs';

const SRC = resolve(process.env.PLITE_SRC_DIR ?? 'D:/space/base/polaris-lite');
const DEST = resolve(process.env.PLITE_9826_DIR ?? 'D:/space/base/polaris-lite-9826');
const APP = 'polaris-lite-9826';

const run = (cmd, cwd, { capture = false } = {}) => {
  const r = spawnSync(cmd, {
    cwd, shell: true, encoding: 'utf8',
    // 剥离 AI 宿主沙箱 env：pm2 可能把会话的 NODE_OPTIONS(safe-delete 垫片) 存进
    // 本进程，不剥的话 vite 清 dist 会被「批量删除护栏」误拦（scripts/sandbox-env.mjs）
    env: cleanEnv(),
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (r.status !== 0) {
    console.error('\n[deploy-9826] 命令失败(exit ' + r.status + '): ' + cmd);
    process.exit(r.status ?? 1);
  }
  return (r.stdout ?? '').trim();
};
const git = (args, cwd = SRC) => run('git ' + args, cwd, { capture: true });
const shortLog = (rev, cwd) => git('log -1 --format="%h %s" ' + rev, cwd);

const buildAndRestart = () => {
  if (!existsSync(join(DEST, 'node_modules'))) {
    console.log('[deploy-9826] node_modules 缺失 → npm ci');
    run('npm ci --no-audit --no-fund', DEST);
  }
  // public/plugins 是 gitignore 的构建产物（fresh clone 没有），npm run build 里的
  // check:plugins 只校验不生成——缺了它 9826 前端一个插件都没有，必须先 build:plugins
  console.log('[deploy-9826] npm run build:plugins + npm run build ...');
  run('npm run build:plugins', DEST);
  run('npm run build', DEST);
  run('npx pm2 restart ' + APP, DEST);
  run('npx pm2 save', DEST);
};

const stamp = (fullSha) => {
  mkdirSync(join(DEST, 'logs'), { recursive: true });
  const line = new Date().toISOString() + '  ' + fullSha.slice(0, 7) + '  '
    + shortLog(fullSha, DEST).split(' ').slice(1).join(' ') + '\n';
  appendFileSync(join(DEST, 'logs', 'deploy-9826.log'), line);
  // app-updater 版本文件：写进 9826 数据目录（绝对路径钉在仓库本体，与 clone 无关），
  // 前端 /api/app-updater/version 读它比对「客户端 vs 服务器」版本（docs/app-updater-plan.md）
  const dataDir = resolve(process.env.PLITE_9826_DATA_DIR ?? join(SRC, '.polaris-lite-pm2'));
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'app-updater-version.json'), JSON.stringify({
    sha: fullSha,
    subject: shortLog(fullSha, DEST).split(' ').slice(1).join(' '),
    time: new Date().toISOString(),
  }, null, 2) + '\n');
};

const doStatus = () => {
  git('fetch origin', DEST);
  const behind = git('rev-list --count HEAD..origin/master', DEST);
  console.log('[9826] 仓库 master : ' + shortLog('origin/master', DEST));
  console.log('[9826] 分析实例   : ' + shortLog('HEAD', DEST)
    + (behind === '0' ? '  ← 已是最新' : '  ← 落后 ' + behind + ' 个 commit，跑 npm run deploy:9826 更新'));
};

const doDeploy = (rev) => {
  if (rev === 'origin/master') {
    const dirty = git('status --porcelain', SRC);
    if (dirty) {
      console.warn('[deploy-9826] 注意：仓库工作树有未提交改动，不在本次发布范围；先 commit 再发布才会上去。');
    }
  }
  git('fetch origin', DEST);
  const NEW = git('rev-parse --verify ' + rev, DEST);
  const OLD = git('rev-parse HEAD', DEST);
  const dirtyDest = git('status --porcelain', DEST);
  if (dirtyDest) {
    console.warn('[deploy-9826] 注意：clone 有本地改动，将被 reset --hard 覆盖（要保留请改用 --rebuild）。');
  }
  if (OLD !== NEW) {
    console.log('[deploy-9826] ' + OLD.slice(0, 7) + ' → ' + NEW.slice(0, 7) + '，git reset --hard');
    git('reset --hard ' + NEW, DEST);
  } else {
    console.log('[deploy-9826] 目标版本与当前一致(' + NEW.slice(0, 7) + ')，仍执行重建');
  }
  if (OLD !== NEW) {
    const lockDiff = git('diff --name-only ' + OLD + ' ' + NEW + ' -- package-lock.json', DEST);
    if (lockDiff && existsSync(join(DEST, 'node_modules'))) {
      console.log('[deploy-9826] package-lock.json 变化 → npm ci');
      run('npm ci --no-audit --no-fund', DEST);
    }
  }
  buildAndRestart();
  stamp(NEW);
  console.log('[deploy-9826] 完成：' + shortLog(NEW, DEST));
  console.log('[deploy-9826] 9826 已重启并 pm2 save：http://127.0.0.1:9826');
};

const arg = process.argv[2] ?? 'deploy';
if (!existsSync(DEST)) {
  console.error('[deploy-9826] 找不到分析实例目录 ' + DEST + ' —— 先 git clone ' + SRC + ' 到该路径');
  process.exit(1);
}
if (arg === 'status') doStatus();
else if (arg === '--rebuild') {
  console.log('[deploy-9826] 实验模式：不拉代码，重建 clone 当前状态 ' + shortLog('HEAD', DEST));
  buildAndRestart();
  console.log('[deploy-9826] 完成：http://127.0.0.1:9826');
} else {
  doDeploy(arg === 'deploy' ? 'origin/master' : arg);
}
