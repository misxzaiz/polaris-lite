/**
 * 会话「设置工作区」弹层（侧栏入口）：遮罩 + 容器，内容由 WorkspacePickerBody 提供，
 * 与输入区抽屉里的选择器共用同一套逻辑与文案（避免两个入口行为不一致）。
 */
import { FolderIcon, CloseIcon } from './icons';
import { WorkspacePickerBody } from './WorkspacePickerBody';

export function WorkspacePicker({
  session,
  onPick,
  onToggleLinked,
  onClose,
}: {
  session: { id: string; title: string; workspaceId?: string; linkedWorkspaceIds?: string[] };
  onPick: (workspaceId: string | undefined) => void;
  onToggleLinked: (workspaceId: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="ws-picker-mask" onClick={onClose}>
      <div className="ws-picker" data-testid="workspace-picker" onClick={(e) => e.stopPropagation()}>
        <div className="ws-picker-head">
          <FolderIcon />
          <span>工作目录 — {session.title}</span>
          <button className="ws-picker-close" aria-label="关闭" onClick={onClose}><CloseIcon /></button>
        </div>
        <p className="ws-picker-hint">绑定后，本对话的 AI 命令将在该目录内执行（bash cwd）。</p>
        <WorkspacePickerBody
          workspaceId={session.workspaceId}
          linkedWorkspaceIds={session.linkedWorkspaceIds}
          onPickMain={onPick}
          onToggleLinked={onToggleLinked}
          closeOnPickMain={false}
          onRequestClose={onClose}
        />
      </div>
    </div>
  );
}
