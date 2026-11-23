/**
 * Markdown 渲染层（把 markdown-parse 产出的 AST 变成 React 元素）。
 *
 * 为什么不装 marked / react-markdown：
 * 1. 插件 bundle 的裸 import 由宿主 import map 解析，多一个包就要同步 external、
 *    esm-shim、import map 三处；一个渲染器不值得这份耦合成本；
 * 2. 全程构造 React 元素，**不用 dangerouslySetInnerHTML**——原文里的 HTML 标签
 *    被当普通文字显示，天然免疫注入（`<img onerror>` 这类 payload 只会变成一行字）；
 * 3. 解析与渲染分离：正则边界由 markdown-parse.ts 承担并可被单元测试覆盖。
 */
import { useState, type ReactNode } from 'react';
import { parseBlocks, parseInline, type Block, type Inline } from './markdown-parse';
import { copyText } from '../shared/copyText';
import { CheckIcon, CopyIcon } from './icons';

/** 超过该长度不再做 Markdown 解析：长文档逐帧重排会明显掉帧，退回纯文本更诚实 */
const MARKDOWN_MAX_CHARS = 40_000;

/** 代码块：语言标签 + 复制按钮（复制失败不静默，按钮上给出反馈） */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'fail'>('idle');
  const copy = () => {
    void (async () => {
      const ok = await copyText(code);
      setState(ok ? 'done' : 'fail');
      setTimeout(() => setState('idle'), 1400);
    })();
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'text'}</span>
        <button
          className={`md-code-copy ${state === 'done' ? 'done' : ''}`}
          onClick={copy}
          title="复制代码"
        >
          {state === 'done' ? <CheckIcon /> : <CopyIcon />}
          <span>{state === 'done' ? '已复制' : state === 'fail' ? '复制失败' : '复制'}</span>
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (n.type) {
      case 'text':
        return n.value;
      case 'plain':
        return n.value;
      case 'code':
        return <code key={key} className="inline">{n.value}</code>;
      case 'strong':
        return <strong key={key}>{renderInline(n.children, key)}</strong>;
      case 'em':
        return <em key={key}>{renderInline(n.children, key)}</em>;
      case 'del':
        return <del key={key}>{renderInline(n.children, key)}</del>;
      case 'link':
        return (
          <a key={key} href={n.href} target="_blank" rel="noreferrer noopener">
            {renderInline(n.children, key)}
          </a>
        );
      default:
        return null;
    }
  });
}

function renderBlock(b: Block, key: string): ReactNode {
  switch (b.type) {
    case 'code':
      return <CodeBlock key={key} lang={b.lang} code={b.value} />;
    case 'heading': {
      const Tag = `h${b.level}` as 'h1';
      return <Tag key={key}>{renderInline(b.children, key)}</Tag>;
    }
    case 'hr':
      return <hr key={key} />;
    case 'quote':
      return <blockquote key={key}>{renderInline(b.children, key)}</blockquote>;
    case 'list':
      return b.ordered ? (
        <ol key={key}>
          {b.items.map((it, i) => <li key={i}>{renderInline(it, `${key}-${i}`)}</li>)}
        </ol>
      ) : (
        <ul key={key}>
          {b.items.map((it, i) => <li key={i}>{renderInline(it, `${key}-${i}`)}</li>)}
        </ul>
      );
    case 'table':
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>{b.head.map((h, i) => <th key={i}>{renderInline(parseInline(h), `${key}-h${i}`)}</th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => <td key={ci}>{renderInline(parseInline(cell), `${key}-${ri}-${ci}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'p':
      return <p key={key}>{renderInline(b.children, key)}</p>;
    default:
      return null;
  }
}

/** 助手消息正文：Markdown 渲染入口 */
export function Markdown({ text }: { text: string }) {
  if (text.length > MARKDOWN_MAX_CHARS) {
    // 超长正文（贴日志/长文）：不做解析，保持纯文本 + 保留换行
    return <span className="md">{text}</span>;
  }
  return <div className="md">{parseBlocks(text).map((b, i) => renderBlock(b, `b${i}`))}</div>;
}
