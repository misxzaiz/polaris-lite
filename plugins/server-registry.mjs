/**
 * 服务端插件注册表：声明「哪些插件有 server 半边、从哪个文件加载」。
 *
 * 与前端的 plugins/build-plugins.mjs 清单对称——前端清单决定 UI 产物，
 * 本清单决定 Node 侧中间件。宿主 server/host.mjs 只遍历本表装配，
 * **不 import 任何具体领域的实现**：新增一个带后端能力的插件 = 写
 * plugins/<id>/server.mjs 并在这里加一行，宿主代码零改动。
 *
 * 契约（每条 entry）：
 *   id     插件目录名，必须与前端清单一致（构建期校验）
 *   entry  相对本文件的模块路径；模块必须导出 createServerPart(options) → 中间件函数
 *
 * options 由宿主注入：{ dataDir, getSession, store, policy, logger }。
 * 插件只拿这些平台能力，拿不到宿主的其它单例——这与前端 SlotHostApi 的
 * 「能力最小化」原则一致。
 *
 * fail-fast：加载失败（文件缺失 / 未导出 createServerPart / 抛错）会让宿主启动失败，
 * 而不是静默 404。理由同前端——「插件说装了但端点不存在」是最难排查的一类故障。
 */
export const SERVER_PLUGINS = [
  { id: 'file-browser', entry: './file-browser/server.mjs' },
  { id: 'agent-bash', entry: './agent-bash/server.mjs' },
  { id: 'agent-files', entry: './agent-files/server.mjs' },
  { id: 'html-preview', entry: './html-preview/server.mjs' },
  { id: 'browser-lite', entry: './browser-lite/server.mjs' },
  { id: 'kv-store', entry: './kv-store/server.mjs' },
  { id: 'plugin-manager', entry: './plugin-manager/server.mjs' },
  { id: 'chat-store', entry: './chat-store/server.mjs' },
  { id: 'phone-agent', entry: './phone-agent/server.mjs' },
  { id: 'codebuddy-engine', entry: './codebuddy-engine/server.mjs' },
];

/**
 * 加载清单里的所有 server 模块，返回工厂清单 [{ id, createServerPart }]。
 * 只做「模块可加载 + 导出签名正确」的校验，**不调用工厂**——真实 options 由宿主
 * createHost 注入，每个宿主实例拿到独立中间件。加载失败 fail-fast。
 *
 * importModule / base 可注入，便于测试用桩模块验证 fail-fast 行为。
 */
export async function loadServerParts({ importModule = (p) => import(p), base = import.meta.url } = {}) {
  const loaded = [];
  for (const { id, entry } of SERVER_PLUGINS) {
    const spec = new URL(entry, base).href;
    const mod = await importModule(spec);
    if (typeof mod.createServerPart !== 'function') {
      throw new Error(`服务端插件 ${id}（${entry}）未导出 createServerPart(options)`);
    }
    loaded.push({ id, createServerPart: mod.createServerPart });
  }
  return loaded;
}
