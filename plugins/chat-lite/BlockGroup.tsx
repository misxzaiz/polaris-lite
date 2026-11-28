/**
 * 可折叠块组（参考 Polaris chat-desk blockGrouping 的收敛版）。
 *
 * 规则（2026-11-20 修订：流式平铺，结束折叠）：
 * - 连续 tool 块（含夹在其间的 thinking 块，思考也按「过程项」归组）归为一个组；
 * - **流式期间一律平铺**：每个工具卡/思考块实时可见，不折叠——用户要能看着 AI 干活；
 * - **流结束统一折叠**：整组收拢为一条汇总条（全部完成/有失败 · N 项），点开回看全程；
 * - 非空 text 块打断分组（正文永远平铺，流式末尾带光标）；
 * - 交互卡（interactive）打断分组：提问卡原位渲染在触发它的工具卡之后
 *   （2026-11-21 修复：此前不打断分组，交互卡被压到整条消息所有工具之下并叠加）。
 * - notice/truncated（自动续写/截断提示）打断分组（2026-11-22 修复：此前不打断，
 *   与 renderBlocks 的 owner 映射口径分叉致组序号漂移，groups[漂移号] 越界读
 *   items → 整页白屏；含多次自动续写的长工具轮次会话打开即崩）。
 */
import { Component } from 'react';
import { Fragment, useEffect, useState } from 'react';
import { CHANNEL_ARTIFACT_RENDERERS, CHANNEL_ARTIFACT_TOOL_NAMES } from '@sdk';
import { Markdown } from './markdown';
import type { AsstBlock, ArtifactCardData, ToolCardData, ToolCardMessage } from './store';
import { ToolCard } from './ToolCard';
import { InteractiveCard } from './InteractiveCard';

/**
 * 单卡渲染隔离罩（六层保底第 3 层，2026-11-28）：一张毒卡只降级一张卡，
 * 不再拖垮整条消息——消息级 MessageBoundary 的粒度细化。
 * 本地 class 而非引宿主 core：插件唯一宿主依赖面是 @sdk（类型/常量），架构门禁。
 */
class CardBoundary extends Component<{ callId?: string; children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) {
    console.error('[chat-lite] 工具卡渲染失败，已降级:', this.props.callId ?? '?', error);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          data-testid="toolcard-render-error"
          style={{ fontSize: 12, color: 'var(--plite-danger, #c0392b)', opacity: 0.85, padding: '2px 0', wordBreak: 'break-all' }}
        >
          工具卡渲染出错，已跳过（{this.state.error.message}）
        </div>
      );
    }
    return this.props.children;
  }
}

/** ToolCard 契约是 ToolCardMessage（msg.tool）；块内只有 card 数据——shim 适配 */
function CardShim({ card }: { card: ToolCardData }) {
  return (
    <CardBoundary callId={card.callId}>
      <ToolCard msg={{ id: '', role: 'tool', content: '', createdAt: 0, tool: card } as ToolCardMessage} />
    </CardBoundary>
  );
}

type ToolBlock = Extract<AsstBlock, { type: 'tool' }>;
type GroupItem = { kind: 'tool'; block: ToolBlock } | { kind: 'thinking'; block: Extract<AsstBlock, { type: 'thinking' }> };

/** 已登记的产物型工具名（小写集合）。产物插件 setup 时写入；未登记时为空集合。 */
function readArtifactToolNames(): Set<string> {
  const raw = (window as unknown as Record<string, unknown>)[CHANNEL_ARTIFACT_TOOL_NAMES];
  return raw instanceof Set ? (raw as Set<string>) : new Set<string>();
}

/** 识别连续过程块（tool + 夹在其间的 thinking）为一个组；非空 text / interactive / notice / truncated 打断 */
function identifyGroups(blocks: AsstBlock[]): { start: number; items: GroupItem[] }[] {
  const groups: { start: number; items: GroupItem[] }[] = [];
  let current: GroupItem[] = [];
  let start = -1;
  const flush = () => {
    if (current.length > 0) {
      groups.push({ start, items: current });
      current = [];
      start = -1;
    }
  };
  blocks.forEach((b, i) => {
    if (b.type === 'tool') {
      if (current.length === 0) start = i;
      current.push({ kind: 'tool', block: b });
      return;
    }
    if (b.type === 'thinking') {
      // 思考也当归组项——夹在工具之间的思考是「过程」的一部分；
      // 组首之前的独立思考（组外）由渲染层单独处理
      if (current.length > 0) current.push({ kind: 'thinking', block: b });
      return;
    }
    if (b.type === 'text' && b.text.trim().length > 0) flush();
    // 交互卡同样是「用户行动点」：提问前后的工具属两段独立过程。若不打断分组，
    // 交互卡会被压到整条消息所有工具之下（多张还会叠加），直到正文出现才归位。
    if (b.type === 'interactive') flush();
    // notice/truncated（自动续写/截断提示）独立渲染，同样打断分组——必须与下方
    // renderBlocks 的 owner 口径完全一致：owner 把这两类当作打断，这里若仍并组，
    // 组序号会相对 owner 永久漂移 +1，下次成组后 groups[漂移号] 越界读 items →
    // 整页白屏（2026-11-22 事故：含多次自动续写的长工具轮次会话打开即崩）。
    if (b.type === 'notice' || b.type === 'truncated') flush();
  });
  flush();
  return groups;
}

/** 思考块：默认折叠，流式期间显示最新思考片段预览；展开看全文（纯文本，保留换行） */
function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 90 ? `…${text.slice(-90)}` : text;
  return (
    <div className={`tc-thinking ${live ? 'live' : ''}`} data-testid="thinking-block">
      <button type="button" className="tc-thinking-summary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <svg className="tc-thinking-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3a6 6 0 0 0-3.6 10.8c.5.4.8.9.9 1.5l.1.7h5.2l.1-.7c.1-.6.4-1.1.9-1.5A6 6 0 0 0 12 3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M9.8 19h4.4M10.6 21.5h2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span className="tc-thinking-label">{live ? '深度思考中' : '深度思考'}</span>
        {!open && <span className="tc-thinking-preview">{preview}</span>}
        <svg className="tc-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d={open ? 'M9 6l6 6-6 6' : 'M6 9l6 6 6-6'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <pre className="tc-thinking-body">{text}</pre>}
    </div>
  );
}

function GroupSummary({ count, anyFail, streaming, onExpand }: {
  count: number; anyFail: boolean; streaming: boolean; onExpand: () => void;
}) {
  return (
    <button type="button" className={`tc-group-summary ${streaming ? 'live' : ''}`} onClick={onExpand} aria-expanded={false}>
      <svg className="tc-group-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      <span className="tc-group-label">工具调用</span>
      <span className={`tc-group-chip ${anyFail ? 'fail' : ''}`}>
        {anyFail ? '有失败' : streaming ? '执行中' : '全部完成'}
      </span>
      <span className="tc-group-count">{count} 项{streaming ? ' · 点击查看' : ''}</span>
      <svg className="tc-chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  );
}

/**
 * 过程块组：流式期间平铺（每张工具卡/思考块实时可见）；
 * 流结束统一折叠为汇总条，点开回看全程。
 */
function ProcessGroup({ items, streaming, artifacts = [] }: { items: GroupItem[]; streaming: boolean; artifacts?: ArtifactCardData[] }) {
  // 组内含「产物型工具卡」（截图/预览等）时不自动收拢：产物是结果而非过程，折叠进
  // 汇总条会让用户找不到截图。工具名不写死：产物插件在 setup 时经
  // CHANNEL_ARTIFACT_TOOL_NAMES 登记自己的工具名（第二个产物插件起零改这里）。
  const artifactNames = readArtifactToolNames();
  const hasArtifactTool = artifacts.length > 0 || items.some(
    (it) => it.kind === 'tool' && artifactNames.has((it.block.card.name || '').toLowerCase()),
  );
  const collapsible = items.length > 1 && !hasArtifactTool;
  const [expanded, setExpanded] = useState(streaming || !collapsible); // 流式=平铺；结束后收拢（产物组除外）
  useEffect(() => {
    // 流结束那一瞬自动收拢；用户随后仍可点汇总条展开回看
    if (!streaming && collapsible) setExpanded(false);
  }, [streaming, collapsible]);

  const toolCount = items.filter((it) => it.kind === 'tool').length;
  const anyFail = items.some((it) => it.kind === 'tool' && (it.block.card.status === 'error' || it.block.card.status === 'denied'));

  // 产物按 callId 跟随对应工具卡：渲染完一张工具卡，紧跟渲染它的截图/预览产物
  const artifactByCall = new Map<string, ArtifactCardData>();
  artifacts.forEach((a) => artifactByCall.set(a.callId, a));
  const renderArtifactsAfter = (callId: string): React.ReactNode[] => {
    const a = artifactByCall.get(callId);
    return a ? [<ArtifactSlot key={`af-${a.callId}`} card={a} />] : [];
  };

  return (
    <div className="tc-group">
      {expanded ? (
        <>
          {items.map((it, i) =>
            it.kind === 'tool'
              ? (
                <Fragment key={`t-${it.block.card.callId || i}`}>
                  <CardShim card={it.block.card} />
                  {renderArtifactsAfter(it.block.card.callId)}
                </Fragment>
              )
              : <ThinkingBlock key={`th-${i}`} text={it.block.text} live={streaming && i === items.length - 1} />,
          )}
          {!streaming && collapsible && (
            <button type="button" className="tc-group-collapse" onClick={() => setExpanded(false)}>收起</button>
          )}
        </>
      ) : (
        <GroupSummary count={toolCount} anyFail={anyFail} streaming={streaming} onExpand={() => setExpanded(true)} />
      )}
    </div>
  );
}

/**
 * assistant blocks 渲染入口：分组 + 平铺（text→Markdown，tool→ToolCard，
 * thinking→ThinkingBlock，interactive→InteractiveCard，notice/truncated→轻提示行）。
 * 连续过程块（tool + 夹在其间的 thinking）归为一组：流式平铺、结束折叠；
 * 非空 text / interactive 块打断分组并原序渲染（流式末尾带光标）；interactive 独立渲染。
 */
export function renderBlocks(
  blocks: AsstBlock[],
  streaming: boolean,
  onResume?: () => void,
  sessionId?: string,
): React.ReactNode {
  const groups = identifyGroups(blocks);

  // 块索引 → 所属组序号（组内为连续 tool / 组内 thinking）
  const owner = new Map<number, number>();
  let gi = -1;
  let inGroup = false;
  blocks.forEach((b, i) => {
    if (b.type === 'tool') {
      if (!inGroup) { gi += 1; inGroup = true; }
      owner.set(i, gi);
    } else if (b.type === 'thinking' && inGroup) {
      // 已在组内（前面有 tool）的思考随组渲染；组外的独立思考不归组
      owner.set(i, gi);
    } else if ((b.type === 'text' && b.text.trim().length > 0) || b.type === 'interactive' || b.type === 'notice' || b.type === 'truncated') {
      inGroup = false;
    }
  });

  // artifact 归位：callId 与某工具卡的 callId 相同 → 该产物属于那次工具调用，
  // 渲染在**该工具卡之后**（组内原位），而不是按事件到达顺序沉到消息尾部。
  // （用户反馈：截图堆在消息最后很奇怪；工具卡才是用户定位「这次调用」的锚点。）
  const artifactOwner = new Map<string, number>(); // artifact callId → 组序号
  blocks.forEach((b, i) => {
    if (b.type === 'artifact' && b.card.callId) {
      for (let k = i - 1; k >= 0; k -= 1) {
        const prev = blocks[k];
        if (prev.type === 'tool' && prev.card.callId === b.card.callId) {
          const g = owner.get(k);
          if (g !== undefined) artifactOwner.set(b.card.callId, g);
          break;
        }
        if (prev.type === 'text' && prev.text.trim().length > 0) break; // 跨正文不算
      }
    }
  });
  // 组序号 → 挂到该组的 artifact 块（保持出现顺序）
  const groupArtifacts = new Map<number, AsstBlock[]>();
  blocks.forEach((b) => {
    if (b.type === 'artifact' && b.card.callId && artifactOwner.has(b.card.callId)) {
      const g = artifactOwner.get(b.card.callId)!;
      if (!groupArtifacts.has(g)) groupArtifacts.set(g, []);
      groupArtifacts.get(g)!.push(b);
    }
  });

  const result: React.ReactNode[] = [];
  // 已渲染块标记（按块对象引用，不用索引区间——组内块之间可能夹着 artifact 等
  // 独立渲染块，按索引区间标记会把夹着的块误标为已处理而跳过渲染，
  // 实测症状：浏览器截图（artifact 块）夹在工具与思考之间时刷新即消失）。
  const processed = new Set<AsstBlock>();
  // card 引用 → 原块引用：processed 按 Set 引用去重，归组的 artifact 必须标记回
  // blocks 里的原对象——此前 `processed.add({ type:'artifact', card })` 新建了对象，
  // 原块永远不被标记 → 截图渲染两次（组内一次 + 原位置再渲染一次）。
  const artifactBlockByCard = new Map<ArtifactCardData, AsstBlock>();
  blocks.forEach((b) => {
    if (b.type === 'artifact') artifactBlockByCard.set(b.card, b);
  });
  blocks.forEach((b, i) => {
    if (processed.has(b)) return;
    const g = owner.get(i);
    // groups[g] 存在性守卫：owner 与 identifyGroups 口径若再分叉，绝不越界崩整页，
    // 降级为平铺渲染（2026-11-22 白屏事故的最后一道兜底）
    if (g !== undefined && groups[g]) {
      const group = groups[g];
      const arts = (groupArtifacts.get(g) ?? []).filter((a): a is Extract<AsstBlock, { type: 'artifact' }> => a.type === 'artifact').map((a) => a.card);
      result.push(
        <ProcessGroup
          key={`g-${group.start}`}
          items={group.items}
          streaming={streaming}
          artifacts={arts}
        />,
      );
      // 只标记组内实际包含的块（按引用）；夹在组内块之间的其它块（artifact 等）不受影响
      group.items.forEach((it) => processed.add(it.block));
      arts.forEach((a) => {
        const original = artifactBlockByCard.get(a);
        if (original) processed.add(original); // 归组的 artifact 随组渲染（标记回块引用）
      });
    } else if (b.type === 'interactive') {
      result.push(<InteractiveCard key={`ia-${b.card.callId}`} callId={b.card.callId} kind={b.card.kind} title={b.card.title} payload={b.card.payload} status={b.card.status} answer={b.card.answer} sessionId={sessionId} />);
    } else if (b.type === 'artifact') {
      // 通用产物块：渲染器由产物插件经 CHANNEL_ARTIFACT_RENDERERS(@sdk) 登记（rendererType → 组件），
      // chat-lite 不再为每种可视化产物加硬编码分支。未登记（插件被停用）渲兜底提示，不崩不空白。
      result.push(<ArtifactSlot key={`af-${b.card.callId}`} card={b.card} />);
    } else if (b.type === 'tool') {
      // owner 有记录但组不存在时的平铺兜底（上方守卫落入此处）：单卡原位渲染
      result.push(<CardShim key={`ft-${b.card.callId || i}`} card={b.card} />);
    } else if (b.type === 'thinking') {
      // 组外独立思考（工具之前/之后的纯思考段）
      result.push(<ThinkingBlock key={`th-${i}`} text={b.text} live={streaming && i === blocks.length - 1} />);
    } else if (b.type === 'notice') {
      // 自动续写等轻提示：小字弱化，不进正文镜像
      result.push(<div key={`n-${i}`} className="tc-notice">{b.text}</div>);
    } else if (b.type === 'truncated') {
      // 截断提示 + 「继续」：点击续开同一 assistant 消息（不新增用户消息、不开新气泡）；
      // 流式中隐藏按钮（续写由循环自动进行）
      result.push(
        <div key={`tr-${i}`} className="tc-truncated">
          <span className="tc-truncated-text">[{b.text}]</span>
          {!streaming && onResume && (
            <button
              type="button"
              className="tc-resume-btn"
              onClick={(e) => { e.stopPropagation(); onResume?.(); }}
            >
              继续
            </button>
          )}
        </div>,
      );
    } else if (b.type === 'text') {
      result.push(<div key={`t-${i}`} className="tc-text"><Markdown text={b.text} /></div>);
      if (streaming && i === blocks.length - 1) result.push(<span key={`cur-${i}`} className="cursor" />);
    }
  });
  return result;
}

/** 产物渲染器类型（window 桥；组件由 html-preview 等产物插件在 setup 时登记） */
type ArtifactRenderer = (props: { callId: string; title: string; data: Record<string, unknown> }) => React.ReactNode;

function ArtifactSlot({ card }: { card: ArtifactCardData }): React.ReactNode {
  const registry = (window as unknown as Record<string, unknown>)[CHANNEL_ARTIFACT_RENDERERS] as
    | Record<string, ArtifactRenderer>
    | undefined;
  const Renderer = card.rendererType ? registry?.[card.rendererType] : undefined;
  if (!Renderer) {
    return (
      <div className="tc-text" data-testid={`af-missing-${card.rendererType}`}>
        产物「{card.title}」的渲染插件未启用（{card.rendererType}）
      </div>
    );
  }
  return <Renderer callId={card.callId} title={card.title} data={card.data} />;
}
