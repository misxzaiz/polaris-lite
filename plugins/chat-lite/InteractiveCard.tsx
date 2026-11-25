/**
 * 交互卡（对齐 Polaris ask_user_question / form / confirm）：
 * - question：多选 + 自定义输入；
 * - form：表单字段收集；
 * - confirm：确认/取消（一步提交，点了就直接回填）。
 * 用户作答 → respondInteractive（window 桥 → cap.interactive）→ agent-loop 继续下一轮。
 *
 * 渲染约定：块已内嵌于 assistant 气泡（含 AI 头像），本组件不重复包 chat-msg 外壳
 * ——外层结构由 BlockGroup/renderBlocks 所在的 chat-bubble 决定。
 */
import { useState } from 'react';
import { respondInteractive } from './interactive-bridge';
import { answerRunnerInteractive } from './runnerBridge';
import type { InteractiveCardData } from './store';

export interface InteractiveCardProps {
  callId: string;
  kind: InteractiveCardData['kind'];
  title: string;
  payload: Record<string, unknown>;
  status?: InteractiveCardData['status'];
  answer?: Record<string, unknown>;
  /** 所属会话（服务端 runner 通道作答回填用；旧通道可缺省） */
  sessionId?: string;
}

export function InteractiveCard({ callId, kind, title, payload, status = 'awaiting', answer, sessionId }: InteractiveCardProps) {
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [submitted, setSubmitted] = useState(status === 'answered');
  // 已回执（事件回填 answered）：展示答案摘要，交互控件收起
  const answered = submitted || status === 'answered';
  const finalAnswer = answer ?? draft;
  // 跳过作答：answer 带 __skipped 标记（agent-loop 按跳过语义喂回模型）
  const skipped = (finalAnswer as { __skipped?: unknown } | undefined)?.__skipped === true;

  const submit = (override?: Record<string, unknown>) => {
    if (answered) return;
    const a = override ?? draft;
    setSubmitted(true);
    // 服务端 runner 通道：作答回填到服务端挂起（任意在线设备先到先得）；
    // 回填失败（runner 不可用/非 runner 会话）回落旧 window 桥（interactive-cards）。
    if (sessionId) {
      void answerRunnerInteractive(sessionId, callId, a).then((handled) => {
        if (handled) return;
        respondInteractive(callId, a);
      });
    } else {
      respondInteractive(callId, a);
    }
  };

  const options = Array.isArray(payload.options) ? payload.options.map(String) : [];
  const fields = Array.isArray(payload.fields) ? payload.fields : [];

  if (answered) {
    return (
      <div className="tc-ia answered" data-testid={`tc-ia-${callId}`}>
        <div className="tc-ia-title">{title}</div>
        <div className="tc-receipt">{skipped ? '已跳过' : `已提交 · ${JSON.stringify(finalAnswer)}`}</div>
      </div>
    );
  }

  return (
    <div className="tc-ia" data-testid={`tc-ia-${callId}`}>
      <div className="tc-ia-title">{title}</div>
      {kind === 'question' && (
        <div className="tc-ia-options">
          {options.map((opt, i) => (
            <label key={i} className="tc-ia-option">
              <input
                type="radio"
                name={callId}
                onChange={() => setDraft((a) => ({ ...a, selected: opt }))}
                checked={draft.selected === opt}
              />
              <span>{opt}</span>
            </label>
          ))}
          <input
            className="tc-ia-custom"
            placeholder="自定义回答（可选）"
            onChange={(e) => setDraft((a) => ({ ...a, customInput: e.target.value }))}
          />
        </div>
      )}
      {kind === 'form' && (
        <div className="tc-ia-form">
          {fields.map((f: { name?: string; label?: string }, i: number) => (
            <label key={i} className="tc-ia-field">
              <span>{f.label ?? f.name ?? `字段${i + 1}`}</span>
              <input
                onChange={(e) => setDraft((a) => ({ ...a, [f.name ?? `field${i}`]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}
      {kind === 'confirm' && (
        <div className="tc-ia-confirm">
          <button className="tc-btn primary" onClick={() => submit({ confirmed: true })}>确认</button>
          <button className="tc-btn danger" onClick={() => submit({ confirmed: false })}>取消</button>
        </div>
      )}
      {kind !== 'confirm' && (
        // 跳过：不填任何答案直接结束本次交互（对齐无人值守超时语义，AI 收到跳过提示后自行继续）
        <div className="tc-ia-actions">
          <button className="tc-btn primary" onClick={() => submit()}>提交</button>
          <button className="tc-btn" onClick={() => submit({ __skipped: true })}>跳过</button>
        </div>
      )}
    </div>
  );
}
