/**
 * 编排协议工具（服务端执行域）：只有 `interactive`。
 *
 * 为什么它留在 runner：`interactive` 依赖 `run.interactives` 挂起表与 SSE 事件回填
 * （POST /api/agent/interactive），是编排层自身的原语，不属任何领域插件的业务。
 *
 * 领域工具（bash / files / files_write / render / browser / read_skill / ledger /
 * translate / suggestions / transcript / phone / market_* / mcp_*）一律由各插件的
 * server 半边在 createServerPart 里经 registry.registerTool 自注册——runner 的
 * 工具表因此为空，新增工具插件无需改这里。
 */
export function registerOrchestrationTools(registry, helpers) {
  const { askInteractive } = helpers;

  registry.registerTool({
    name: 'interactive',
    noApproval: true,
    descriptor: {
      type: 'function',
      function: {
        name: 'interactive',
        description:
          '向用户发起结构化交互并等待作答（question 多选 / form 表单 / confirm 确认）。缺少必要信息时直接问。超时返回 {"__timeout":true}。',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['question', 'form', 'confirm'] },
            title: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, label: { type: 'string' } },
              },
            },
          },
          required: ['kind', 'title'],
        },
      },
    },
    async invoke({ run, call, args, signal }) {
      const decision = await askInteractive(run, call, args, signal);
      return { ok: true, stdout: decision, stderr: '' };
    },
  });
}
