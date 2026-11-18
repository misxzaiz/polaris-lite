/** 附件预览条：图片缩略图 + 细线文件图标。 */
import type { Attachment } from './attachments';
import { formatFileSize, isImageMime } from './attachments';
import { CloseIcon, FileIcon } from './icons';

export function AttachmentStrip({ attachments, onRemove }: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="chat-attach-strip" data-testid="attachment-strip">
      {attachments.map((a) => (
        <div key={a.id} className="chat-attach-item" title={`${a.name} · ${formatFileSize(a.size)}`}>
          {isImageMime(a.mime) && a.previewUrl ? (
            <div className="chat-attach-thumb">
              <img src={a.previewUrl} alt={a.name} />
              <span className="chat-attach-name">{a.name}</span>
            </div>
          ) : (
            <div className="chat-attach-file">
              <span className="chat-attach-icon"><FileIcon /></span>
              <span className="chat-attach-name">{a.name}</span>
              <span className="chat-attach-size">{formatFileSize(a.size)}</span>
            </div>
          )}
          <button className="chat-attach-remove" aria-label={`移除 ${a.name}`} onClick={() => onRemove(a.id)}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
