/**
 * plugin-market 在服务端执行域的工具声明（market_list / market_install / market_uninstall）。
 * 安装/卸载仍走本插件自己的 /api/market/*（sha256/路径围栏/审计原样生效）。
 * 三连免审批：服务端已做围栏，审批只会增加噪音。
 */
const FEEDBACK_CAP = 8 * 1024;

export function registerMarketTools(registry) {
  for (const [mName, mPath] of [
    ['market_list', '/api/market/list'],
    ['market_install', '/api/market/install'],
    ['market_uninstall', '/api/market/uninstall'],
  ]) {
    registry.registerTool({
      name: mName,
      noApproval: true,
      descriptor: {
        type: 'function',
        function: {
          name: mName,
          description: mName === 'market_list'
            ? '列出商城源里可安装的插件及安装状态（含 Claude Code 商城：source 为 marketplace 名、id 为插件名的条目标记为 (cc)）。'
            : mName === 'market_install'
              ? '从商城安装插件。普通目录源传 source（源名）+id；Claude Code 商城 source 直接填 marketplace 名（仅导入声明型资源，不运行外部 JS）。target 决定作用域：global（默认）| project。'
              : '卸载一个已安装的外部插件（刷新页面生效）。',
          parameters: {
            type: 'object',
            properties: {
              ...(mName !== 'market_list' ? {
                source: { type: 'string', description: '商城源名或 CC marketplace 名' },
                id: { type: 'string', description: '插件 id' },
                ...(mName === 'market_install' ? { target: { type: 'string', enum: ['global', 'project'], description: '作用域：global（默认）| project' } } : {}),
              } : {}),
            },
          },
        },
      },
      async invoke({ args, signal, host }) {
        const r = await host.callEndpoint(mPath, {
          ...(mName === 'market_list' ? {} : {
            source: String(args.source ?? ''),
            id: String(args.id ?? ''),
            ...(mName === 'market_install' && args.target ? { target: String(args.target) } : {}),
          }),
        }, signal);
        const j = r.json ?? {};
        const ok = r.ok && j.ok !== false;
        return { ok, stdout: JSON.stringify(j).slice(0, FEEDBACK_CAP), stderr: ok ? '' : String(j.error ?? j.warns ?? `HTTP ${r.status}`).slice(0, 500) };
      },
    });
  }
}
