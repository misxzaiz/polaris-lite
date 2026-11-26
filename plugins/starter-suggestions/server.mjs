/**
 * starter-suggestions 服务端半边：把 suggestions 工具声明注册进服务端执行域。
 *
 * 不提供 HTTP 端点：建议池存于 kv（namespace=starter-suggestions），工具与面板
 * 共用同一份（面板走 cap.kv，工具经 runner 注入的 host.kv）。删除本文件时宿主
 * 照常启动，只是 AI 的 suggestions 工具消失。
 */
import { registerSuggestionsTool } from './tool.mjs';

export function createServerPart(options = {}) {
  if (options.registry) registerSuggestionsTool(options.registry);
  return function starterSuggestionsServer(_req, _res, next) {
    return next?.();
  };
}
