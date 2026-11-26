/**
 * 空态建议：本插件自己的**兜底池**与分类展示文案。
 *
 * 为什么不再从 plugins/shared/ 取：那个文件同时承载了 starter-suggestions 的
 * 30 条种子池（业务数据），放在"共享工具目录"里等于让两个插件共享一份业务内容
 * ——改一处会影响另一处，且 chat-lite 无法单独演进自己的兜底文案。
 * 现在：完整建议池归 starter-suggestions（它的 kv 池经 /api/kv 供本插件读取），
 * 本文件只保留数量很小、明确属于"对话空态兜底"的几条。
 */

export type CategoryId = 'explore' | 'tools' | 'code' | 'write' | 'think' | 'play';

export interface Suggestion {
  label: string;
  prompt: string;
  category: CategoryId;
}

export const CATEGORY_LABEL: Record<CategoryId, string> = {
  explore: '探索发现',
  tools: '工具执行',
  code: '编程',
  write: '写作表达',
  think: '思考决策',
  play: '趣味灵感',
};

/** 兜底池：starter-suggestions 未启用 / kv 池为空时使用（不追求覆盖面，只保证空态可用） */
export const SUGGESTIONS: Suggestion[] = [
  {
    label: '今天有什么值得关注的大事',
    prompt: '浏览一下今天的新闻，挑出 3 条最值得关注的，每条用两三句话讲清楚它为什么重要。',
    category: 'explore',
  },
  {
    label: '帮我读一个网页',
    prompt: '打开这个链接并总结要点：',
    category: 'tools',
  },
  {
    label: '看看这个项目',
    prompt: '看一下当前工作区的目录结构，用几句话说明它是做什么的、入口在哪。',
    category: 'code',
  },
  {
    label: '把想法整理成提纲',
    prompt: '把我的想法整理成一份结构化提纲，标出还缺哪些信息：',
    category: 'write',
  },
  {
    label: '帮我做个决定',
    prompt: '我有两个方案，帮我列出取舍维度并给出建议：',
    category: 'think',
  },
  {
    label: '造一个小玩具',
    prompt: '用自包含 HTML 做一个能直接玩的小交互，风格简洁，不要引外部资源。',
    category: 'play',
  },
];

function shuffle<T>(list: T[]): T[] {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 从建议池随机抽取 count 条：
 * - 优先从 prefer 类别各抽一条，保证一批覆盖不同能力域；
 * - exclude 中的 prompt 会被避开（用于「换一批」时排除上一批）；
 * - source 缺省用内置 SUGGESTIONS；starter-suggestions 插件传入 kv 池（已含内置+AI 新增）。
 */
export function sampleSuggestions(options: { count?: number; exclude?: string[]; prefer?: CategoryId[]; source?: Suggestion[] } = {}): Suggestion[] {
  const count = options.count ?? 4;
  const exclude = new Set(options.exclude ?? []);
  const prefer = options.prefer ?? [];
  const all = options.source ?? SUGGESTIONS;

  const usable = all.filter((s) => !exclude.has(s.prompt));
  const source = usable.length >= count ? usable : all;

  const byCat = new Map<CategoryId, Suggestion[]>();
  for (const s of source) {
    const arr = byCat.get(s.category) ?? [];
    arr.push(s);
    byCat.set(s.category, arr);
  }

  const takeOne = (arr: Suggestion[]): Suggestion => arr.splice(Math.floor(Math.random() * arr.length), 1)[0];

  const preferredCats = prefer.filter((c) => (byCat.get(c)?.length ?? 0) > 0);
  const otherCats = shuffle([...byCat.keys()].filter((c) => !preferredCats.includes(c)));

  const chosen: Suggestion[] = [];
  for (const cat of [...preferredCats, ...otherCats]) {
    if (chosen.length >= count) break;
    chosen.push(takeOne(byCat.get(cat)!));
  }
  const rest = shuffle([...byCat.values()].flat());
  for (const s of rest) {
    if (chosen.length >= count) break;
    if (!chosen.includes(s)) chosen.push(s);
  }
  return chosen.slice(0, count);
}
