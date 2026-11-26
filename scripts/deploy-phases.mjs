/**
 * deploy-phases.mjs —— 把 deploy-9826 的原始输出行翻译成「用户看得懂的阶段名」。
 *
 * 独立成模块的原因：worker（scripts/deploy-worker.mjs）需要它推进 job.json 的
 * phase，测试要单独验证这张映射表——而 worker 是带顶层副作用的一次性脚本，
 * 不能被 import。这里只放纯函数。
 */

/** @type {[RegExp, string][]} 顺序敏感：先说「安装依赖」，再说「构建」 */
export const DEPLOY_PHASES = [
  [/npm ci/i, '安装依赖'],
  [/build:plugins/i, '构建插件'],
  [/vite v\d|building for production|vite build|✓ built|npm run build/i, '构建前端'],
  [/pm2 restart|\[PM2\]/i, '重启 9826'],
  [/\[deploy-9826\] 完成/, '完成'],
];

/**
 * 由一行输出推断阶段。
 * 返回 null 表示「这行不改变阶段」——调用方据此避免无意义地回写 job.json。
 * 注意 `[deploy-9826] 完成` 必须优先于其它规则：它同时命中 `npm run build` 之外的词，
 * 但终态只能是「完成」。
 */
export function phaseOf(line, current = '') {
  const text = String(line ?? '');
  if (!text) return null;
  for (const [re, name] of DEPLOY_PHASES) {
    if (re.test(text)) return name === current ? null : name;
  }
  return null;
}
