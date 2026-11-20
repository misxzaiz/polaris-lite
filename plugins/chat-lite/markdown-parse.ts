/**
 * Markdown 解析器（纯函数，无 React、无 DOM）。
 *
 * 为什么单独拆出来：
 * 1. 正则边界（围栏未闭合、** 与 * 的优先级、列表粘连）是这类渲染器唯一容易错的地方，
 *    而「解析」比「渲染」好测得多——纯输入输出，不需要 React 也不需要浏览器；
 * 2. 流式场景要求「未闭合围栏把剩余内容全部当代码块」，这个行为必须有回归网兜住，
 *    否则某次改动就可能让正文在半截代码块里来回跳。
 *
 * 支持范围刻意克制：围栏代码块、行内代码、标题、有序/无序列表、引用、分割线、
 * 加粗/斜体/删除线、链接。不做表格/图片/脚注——需要时再加。
 * 安全：不产出任何 HTML 字符串，也不放行 javascript:/data: 链接。
 */

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  /** 非法/不安全的链接：保留原文，不制造可点链接 */
  | { type: 'plain'; value: string };

export type Block =
  | { type: 'code'; lang: string; value: string }
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'hr' }
  | { type: 'quote'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'p'; children: Inline[] };

/** 只放行安全协议（避免 javascript: / data: 一类链接） */
export function safeHref(url: string): string | null {
  const u = url.trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null;
}

const RE_FENCE = /^\s{0,3}```(.*)$/;
const RE_FENCE_END = /^\s{0,3}```\s*$/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_UL = /^\s*[-*+]\s+(.*)$/;
const RE_OL = /^\s*\d+[.)]\s+(.*)$/;

/** 行内解析：`code` / **粗** / __粗__ / *斜* / _斜_ / ~~删~~ / [文本](链接) */
export function parseInline(text: string): Inline[] {
  const pattern =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]*\]\([^)\s]+\))/g;
  const out: Inline[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    const token = m[0];

    if (token.startsWith('`')) {
      out.push({ type: 'code', value: token.slice(1, -1) });
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push({ type: 'strong', children: parseInline(token.slice(2, -2)) });
    } else if (token.startsWith('~~')) {
      out.push({ type: 'del', children: parseInline(token.slice(2, -2)) });
    } else if (token.startsWith('*') || token.startsWith('_')) {
      out.push({ type: 'em', children: parseInline(token.slice(1, -1)) });
    } else {
      const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      const href = link ? safeHref(link[2]) : null;
      if (link && href) out.push({ type: 'link', href, children: parseInline(link[1]) });
      else out.push({ type: 'plain', value: token });
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out;
}

/** 块级解析：按行扫描，块之间以空行/换类型为界 */
export function parseBlocks(src: string): Block[] {
  const lines = src.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块：未闭合（流式中）→ 剩余全部并入代码块，内容不会来回跳变
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !RE_FENCE_END.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过闭合围栏（未闭合时已越界，循环自然结束）
      blocks.push({ type: 'code', lang, value: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    if (RE_HR.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // 表格（管道表）：表头行 + 分隔行（|---|---|）+ 数据行；流式中未闭合也能渐进渲染
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const splitRow = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = splitRow(line);
      i += 2; // 跳过表头与分隔行
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', head, rows });
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        quote.push((RE_QUOTE.exec(lines[i]) as RegExpExecArray)[1]);
        i += 1;
      }
      blocks.push({ type: 'quote', children: parseInline(quote.join('\n')) });
      continue;
    }

    // 列表：同类连续项合并；遇到空行或换类型即结束（不做嵌套，lite 形态够用）
    const ordered = RE_OL.test(line) && !RE_UL.test(line);
    if (ordered || RE_UL.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length) {
        const cur = ordered ? RE_OL.exec(lines[i]) : RE_UL.exec(lines[i]);
        if (!cur) break;
        items.push(parseInline(cur[1]));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // 段落：吃到空行或下一个块级起始符为止
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim() === '' ||
        RE_FENCE.test(l) ||
        RE_HEADING.test(l) ||
        RE_HR.test(l) ||
        RE_QUOTE.test(l) ||
        RE_UL.test(l) ||
        RE_OL.test(l) ||
        (l.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1]))
      ) break;
      para.push(l);
      i += 1;
    }
    // 防御：若首行即被判定为块级起始符（互斥漏判），至少前进一步避免死循环
    if (para.length === 0) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'p', children: parseInline(para.join('\n')) });
  }

  return blocks;
}
