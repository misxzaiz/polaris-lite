/**
 * 交互卡（对齐 Polaris ask_user_question / form / confirm）：
 * - question：多选 + 自定义输入；
 * - form：表单字段收集；
 * - confirm：确认/取消。
 * 用户作答 → cap.interactive.respond 回填 → agent-loop 继续下一轮。
 */
import { useState } from 'react';
import { respondInteractive } from './interactive-bridge';

export interface InteractiveCardProps {
  callId: string;
  kind: 'question' | 'form' | 'confirm';
  title: string;
  payload: Record<string, unknown>;
}

export function InteractiveCard({ callId, kind, title, payload }: InteractiveCardProps) {
  const [answer, setAnswer] = useState<Record<string, unknown>>({});
  const [answered, setAnswered] = useState(false);

  const submit = () => {
    setAnswered(true);
    respondInteractive(callId, answer);
  };

  const options = Array.isArray(payload.options) ? payload.options.map(String) : [];
  const fields = Array.isArray(payload.fields) ? payload.fields : [];

  return (
    <div className="chat-msg tool">
      <div className="chat-avatar" aria-hidden="true"><span className="tc-letter">?</span></div>
      <div className="tc-interactive" data-testid={`tc-ia-${callId}`}>
        <div className="tc-ia-title">{title}</div>
        {kind === 'question' && (
          <div className="tc-ia-options">
            {options.map((opt, i) => (
              <label key={i} className="tc-ia-option">
                <input
                  type="radio"
                  name={callId}
                  onChange={(e) => setAnswer((a) => ({ ...a, selected: opt }))}
                  checked={answer.selected === opt}
                />
                <span>{opt}</span>
              </label>
            ))}
            <input
              className="tc-ia-custom"
              placeholder="自定义回答（可选）"
              onChange={(e) => setAnswer((a) => ({ ...a, customInput: e.target.value }))}
            />
          </div>
        )}
        {kind === 'form' && (
          <div className="tc-ia-form">
            {fields.map((f: any, i: number) => (
              <label key={i} className="tc-ia-field">
                <span>{f.label ?? f.name ?? `字段${i + 1}`}</span>
                <input
                  onChange={(e) => setAnswer((a) => ({ ...a, [f.name ?? `field${i}`]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        )}
        {kind === 'confirm' && (
          <div className="tc-ia-confirm">
            <button className="tc-btn primary" onClick={() => setAnswer((a) => ({ ...a, confirmed: true }))}>确认</button>
            <button className="tc-btn danger" onClick={() => setAnswer((a) => ({ ...a, confirmed: false }))}>取消</button>
          </div>
        )}
        {!answered && (
          <button className="tc-btn primary tc-submit" onClick={submit}>提交</button>
        )}
        {answered && <div className="tc-receipt">已提交</div>}
      </div>
    </div>
  );
}
