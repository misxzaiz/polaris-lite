/**
 * skill-loader 在服务端执行域的工具声明（read_skill）。
 * 读取仍走本插件自己的 /api/skills/read。
 */
export function registerReadSkillTool(registry) {
  registry.registerTool({
    name: 'read_skill',
    descriptor: {
      type: 'function',
      function: {
        name: 'read_skill',
        description: '读取技能全文（SKILL.md）。先用系统提示附录里的技能索引选名字，再用本工具读全文。',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    },
    async invoke({ args, signal, host }) {
      const r = await host.get(`/api/skills/read?name=${encodeURIComponent(String(args.name ?? ''))}`, signal);
      const j = r.json ?? {};
      const ok = r.ok && j.ok !== false;
      return { ok, stdout: ok ? (j.content ?? '') : '', stderr: ok ? '' : (j.error ?? `HTTP ${r.status}`) };
    },
  });
}
