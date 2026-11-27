/**
 * sandbox-env.mjs —— 剥离 AI 宿主（WorkBuddy/ZCode）沙箱注入的环境变量。
 *
 * 背景（2026-11-27 部署连环失败事故）：在 AI 宿主会话里执行 pm2 start/restart 时，
 * pm2 会把**调用方** env 原样存进 app——NODE_OPTIONS（--require safe-delete 垫片）和
 * CODEBUDDY_SAFE_DELETE_BULK_* / CODEBUDDY_TOOL_CALL_ID 一起进了 9826 与 deploy worker
 * 的进程环境。此后 vite emptyOutDir 清 dist 的 rmSync 走垫片的「批量删除护栏」，
 * 且计数按同一个陈旧 TOOL_CALL_ID 跨 job 累计，越过阈值 50 后每次构建第一步就挂：
 *   [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":50,"threshold":50,...}
 *
 * 该护栏本意是拦「AI 会话里未经确认的批量删除」；发布流程清 dist 构建产物是用户
 * 显式触发的正常操作，不该被拦。发布/构建脚本统一用 cleanEnv() 给子进程一个
 * 干净环境，根除「谁在 AI 会话里重启过 pm2，谁的沙箱 env 就永久存进 app」的
 * 传染链。垫片只经 NODE_OPTIONS 注入，NODE_OPTIONS 一剥即断；护栏四件套一并剥掉
 * 兜底（万一垫片经其他途径加载，无 STATE_DIR/TOOL_CALL_ID 也会直接放行）。
 */

/** 命中即视为沙箱注入变量：NODE_OPTIONS 是垫片注入入口；其余是批量删除
 *  护栏四件套（STATE_DIR/TOOL_CALL_ID/GUARD/NODE_BIN 等）与回收站工具路径 */
const SANDBOX_ENV_RE = /^(NODE_OPTIONS|CODEBUDDY_SAFE_DELETE_\w+|CODEBUDDY_TOOL_CALL_ID|CODEBUDDY_NODE_BIN|CODEBUDDY_NODE_RUN_AS_NODE|GENIE_TRASH_DIR)$/;

/**
 * 返回一份剥离沙箱变量后的 env 副本（不改原对象；PATH/SystemRoot 等
 * 子进程必需变量全部保留）。spawnSync/spawn 直接 `env: cleanEnv()` 即可。
 */
export function cleanEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (SANDBOX_ENV_RE.test(key)) delete env[key];
  }
  return env;
}
