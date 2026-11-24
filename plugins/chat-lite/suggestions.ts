/** 空态建议池：label 只做展示，prompt 为点击后填入输入框的完整提示词。 */
import type { CategoryId, Suggestion } from '../shared/suggestion-types';

export type { CategoryId, Suggestion };
export { CATEGORY_LABEL, SUGGESTIONS } from '../shared/suggestion-types';
import { SUGGESTIONS } from '../shared/suggestion-types';


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

