/**
 * 摄入归一（P0 渲染崩溃审计 · 六层保底第 2 层，2026-11-28）。
 *
 * 根因类：服务端/IndexedDB 摄入零形状消毒——毒数据直达渲染层，单条畸形块即
 * 开屏白屏（BlockGroup 2026-11-22 事故同构）。本模块在数据进 store 前做白名单级
 * 整形，三条纪律：
 *  - 只删毒不造数据：合法块原样透传（引用展开保留全部字段）；
 *  - 白名单外的块类型、缺 card 的 tool/interactive/artifact 块=不可渲染=毒，丢弃；
 *  - 文本类块 text 非字符串时兜底 String()（不丢块，丢的是崩溃触发面）。
 *
 * 纯函数零依赖（类型经 import type 擦除，运行时不加载 store.ts）——node 测试可直测。
 */
import type { StoreMessage } from './store';

/** 块类型白名单（与 src/core/types.ts 的 AsstBlock 联合一一对应；新增块类型须同步） */
const BLOCK_TYPES = new Set(['text', 'thinking', 'tool', 'interactive', 'notice', 'truncated', 'artifact']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 单块整形：毒块返回 null（调用方过滤）；合法块返回保留全字段的副本 */
function normalizeBlock(b: unknown): Record<string, unknown> | null {
  if (!isObj(b)) return null;
  const type = b.type;
  if (typeof type !== 'string' || !BLOCK_TYPES.has(type)) return null;
  if (type === 'text' || type === 'thinking' || type === 'notice' || type === 'truncated') {
    // 文本类：text 是唯一渲染依赖，非字符串兜底转换（null/undefined → ''）
    return { ...b, text: typeof b.text === 'string' ? b.text : String(b.text ?? '') };
  }
  // card 类：card 缺失/非对象 = 渲染必崩 = 毒，丢弃
  return isObj(b.card) ? b : null;
}

/**
 * 消息数组整形（摄入唯一入口）：
 * - 非数组输入 → []（坏会话隔离为空消息，不崩流）；
 * - 无 role 的条目丢弃；assistant.blocks 逐块白名单整形；
 * - assistant 无 blocks（纯 content 旧形态）与 user/tool 消息原样透传。
 */
export function normalizeMessages(messages: unknown): StoreMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: StoreMessage[] = [];
  let dropped = 0;
  for (const m of messages) {
    if (!isObj(m) || typeof m.role !== 'string') { dropped += 1; continue; }
    if (m.role === 'assistant' && Array.isArray(m.blocks)) {
      const blocks: Record<string, unknown>[] = [];
      for (const b of m.blocks) {
        const nb = normalizeBlock(b);
        if (nb) blocks.push(nb);
        else dropped += 1;
      }
      // 整形后的块是白名单窄化形态，与 AsstBlock 联合的宽类型不逐字段对齐——
      // 渲染层自有守卫（CardBoundary/类目 switch），这里经 unknown 断言回类型世界
      out.push({ ...m, blocks } as unknown as StoreMessage);
      continue;
    }
    out.push(m as unknown as StoreMessage);
  }
  if (dropped > 0) {
    // eslint-disable-next-line no-console -- 毒块丢弃必须留痕（否则像静默吞错的旧坑）
    console.warn(`[chat-lite] 摄入归一：丢弃 ${dropped} 个无法安全渲染的畸形条目/块`);
  }
  return out;
}
