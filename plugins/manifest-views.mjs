/**
 * `contributes.views` 的解析与校验（构建期门禁的纯函数部分）。
 *
 * 抽出来的理由：门禁写在一个 900 行的构建脚本里就只能「整仓跑一遍看有没有红」，
 * 没法对「viewType 少前缀」「组件没导出」这类具体规则做回归——而这三条规则正好对应
 * 三种线上事故（互相顶掉、插件装了但视图打不开、树里持久化了一个红框）。
 * 所以把解析与判定做成不依赖文件系统的纯函数，由 `build-plugins.mjs` 与测试共用。
 *
 * 不依赖 fs / console / process：错误以字符串数组返回，由调用方决定抛还是打印。
 */

/** 与 src/core/workspace/schema.ts 的 ID_PATTERN 保持一致（viewType 会被拼进 aria-controls） */
export const VIEW_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** auth 不是锚点：门禁路径在工作区树之外 */
export const VIEW_ANCHORS = ['sidebar', 'stream', 'input', 'panel'];

/** 宿主保留命名空间（host.slot.* 承载四个锚点原有的槽位内容） */
export const RESERVED_VIEW_PREFIX = 'host.';

/** 取 `key: [` 起始的方括号内容（浅层扫描，够用于 manifest 这种字面量） */
function extractBracket(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return null;
}

/**
 * 从 manifest 的 contributes 对象字面量里读出 views 项。
 * 只接受「对象字面量 + 字面量字段」：manifest 必须是静态可判的，写成变量就没法在构建期判定。
 */
export function parseViewContributions(contributesLiteral, pluginId) {
  const errors = [];
  const viewsAt = /\bviews\s*:\s*\[/.exec(contributesLiteral);
  if (!viewsAt) return { items: [], errors };
  const arr = extractBracket(contributesLiteral, viewsAt.index + viewsAt[0].length - 1);
  if (!arr) {
    errors.push(`插件 ${pluginId}：manifest.contributes.views 方括号不闭合`);
    return { items: [], errors };
  }

  const str = (body, field) => {
    const m = new RegExp(`\\b${field}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`).exec(body);
    return m ? m[1] : undefined;
  };

  const items = [];
  let i = 0;
  while (i < arr.length) {
    if (arr[i] === '{') {
      const body = extractBracket(arr, i);
      if (!body) {
        errors.push(`插件 ${pluginId}：contributes.views 里有不闭合的对象字面量`);
        return { items, errors };
      }
      items.push({
        viewType: str(body, 'viewType'),
        component: str(body, 'component'),
        title: str(body, 'title'),
        defaultAnchor: str(body, 'defaultAnchor'),
      });
      i += body.length;
      continue;
    }
    i += 1;
  }
  return { items, errors };
}

/** 组件是否从入口模块导出（命名导出函数/常量/类，或 `export { X }` / `export {X} from`） */
export function isExported(entrySrc, component) {
  if (!component) return false;
  const named = new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:function|const|class)\\s+${component}\\b`);
  const reExport = new RegExp(`\\bexport\\s*(?:type\\s*)?\\{[^}]*\\b${component}\\b`);
  return named.test(entrySrc) || reExport.test(entrySrc);
}

/**
 * 校验一个插件的视图贡献。
 * @param {{ pluginId: string, entrySrc: string, views: Array<object>, seen?: Map<string,string> }} args
 *   `seen` 跨插件共享，用于查重复 viewType（会就地写入）。
 * @returns {string[]} 错误列表，空数组即通过
 */
export function validateViews({ pluginId, entrySrc, views, seen = new Map() }) {
  const errors = [];
  for (const v of views) {
    const label = `插件 ${pluginId} 的 contributes.views 项（${v.viewType ?? '缺少 viewType'}）`;
    if (!v.viewType) {
      errors.push(`${label}：缺少 viewType`);
      continue;
    }
    if (!VIEW_ID_PATTERN.test(v.viewType)) {
      errors.push(`${label}：viewType 只允许小写字母数字与 . _ -`);
    }
    if (!v.viewType.startsWith(`${pluginId}.`)) {
      errors.push(`${label}：viewType 必须以 "${pluginId}." 开头（否则两个插件会互相顶掉注册）`);
    }
    if (v.viewType.startsWith(RESERVED_VIEW_PREFIX)) {
      errors.push(`${label}：${RESERVED_VIEW_PREFIX} 是宿主保留命名空间（host.slot.* 已占用）`);
    }
    if (seen.has(v.viewType)) {
      errors.push(`viewType 重复：${v.viewType} 被 ${seen.get(v.viewType)} 与 ${pluginId} 同时声明`);
    } else {
      seen.set(v.viewType, pluginId);
    }
    if (!v.title || !v.title.trim()) errors.push(`${label}：缺少 title（无标题的视图没有可访问名）`);
    if (!v.component) errors.push(`${label}：缺少 component（入口里的组件导出名）`);
    else if (!isExported(entrySrc, v.component)) {
      errors.push(`${label}：入口没有导出组件 ${v.component}（运行时只会得到「未导出组件」红框）`);
    }
    if (v.defaultAnchor !== undefined && !VIEW_ANCHORS.includes(v.defaultAnchor)) {
      errors.push(`${label}：defaultAnchor 只能是 ${VIEW_ANCHORS.join('/')}（auth 不是锚点）`);
    }
  }
  return errors;
}
