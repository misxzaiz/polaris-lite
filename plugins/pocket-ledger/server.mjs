/**
 * pocket-ledger 服务端半边：只做一件事——把 ledger 工具声明注册进服务端执行域。
 *
 * 不提供 HTTP 端点：账目数据存于 kv（cap.kv / kv-store），工具经 runner 注入的
 * host.kv 读写，计算用本插件自己的 ledger-core.cjs。删除本文件时宿主照常启动，
 * 只是 AI 的 ledger 工具消失（面板不受影响）。
 */
import { createRequire } from 'node:module';
import { registerLedgerTool } from './tool.mjs';

const require = createRequire(import.meta.url);
// 计算内核是本插件自己的 vendor（面板/AI 工具同一权威）。
const ledgerCore = require('./ledger-core.cjs');

export function createServerPart(options = {}) {
  if (options.registry) registerLedgerTool(options.registry, { ledgerCore });
  // 本插件无自有 HTTP 路由：直接放行后续中间件。
  return function pocketLedgerServer(_req, _res, next) {
    return next?.();
  };
}
