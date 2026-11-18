/**
 * 附件类型与校验（对齐 Polaris chat-desk 的 attachment.ts 行为规格）。
 * 三通道进入（粘贴/拖拽/选择器）；图片 base64、文本直存避免膨胀。
 */

export const ATTACHMENT_LIMITS = {
  maxCount: 10,
  imageMaxBytes: 20 * 1024 * 1024,
  fileMaxBytes: 50 * 1024 * 1024,
  totalMaxBytes: 100 * 1024 * 1024,
} as const;

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'] as const;

export const TEXT_TYPES = [
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/xml',
  'application/json', 'application/xml', 'application/javascript', 'application/typescript',
  'application/x-yaml', 'application/yaml', 'application/toml',
] as const;

export const TEXT_EXTS = [
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.html', '.css', '.scss', '.xml', '.svg',
] as const;

/** lite 附件对象：图片走 content(base64 data URL)，文本走 textContent */
export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** 图片：data URL（含前缀） */
  content?: string;
  /** 文本/代码：原文（避免 base64 膨胀） */
  textContent?: string;
  /** 预览用 URL（图片 src） */
  previewUrl?: string;
}

export function isImageMime(mime: string): boolean {
  return (IMAGE_TYPES as readonly string[]).includes(mime);
}

export function isTextLike(mime: string, name: string): boolean {
  if ((TEXT_TYPES as readonly string[]).includes(mime)) return true;
  const lower = name.toLowerCase();
  return (TEXT_EXTS as readonly string[]).some((ext) => lower.endsWith(ext));
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function acceptAttr(): string {
  return [...IMAGE_TYPES, ...TEXT_EXTS].join(",");
}

/** 单件校验：返回错误消息或 null */
export function validateFile(file: File): string | null {
  if (isImageMime(file.type)) {
    if (file.size > ATTACHMENT_LIMITS.imageMaxBytes) {
      return `图片「${file.name}」超过 ${formatFileSize(ATTACHMENT_LIMITS.imageMaxBytes)} 上限`;
    }
    return null;
  }
  if (isTextLike(file.type, file.name)) {
    if (file.size > ATTACHMENT_LIMITS.fileMaxBytes) {
      return `文件「${file.name}」超过 ${formatFileSize(ATTACHMENT_LIMITS.fileMaxBytes)} 上限`;
    }
    return null;
  }
  return `不支持的类型「${file.name}」（${file.type || '未知'}）`;
}

/** 整批校验（数量/总量），在单件校验之后调用 */
export function validateBatch(existing: Attachment[], incoming: File[]): string | null {
  if (existing.length + incoming.length > ATTACHMENT_LIMITS.maxCount) {
    return `附件最多 ${ATTACHMENT_LIMITS.maxCount} 个`;
  }
  const incomingTotal = incoming.reduce((sum, f) => sum + f.size, 0);
  const existingTotal = existing.reduce((sum, a) => sum + a.size, 0);
  if (existingTotal + incomingTotal > ATTACHMENT_LIMITS.totalMaxBytes) {
    return `附件总量超过 ${formatFileSize(ATTACHMENT_LIMITS.totalMaxBytes)}`;
  }
  return null;
}

/** File → Attachment（图片读 base64，文本读原文；大文件读失败返回错误） */
export async function fileToAttachment(file: File): Promise<Attachment | { error: string }> {
  const base: Attachment = {
    id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
  };
  try {
    if (isImageMime(file.type)) {
      const dataUrl = await readAsDataURL(file);
      return { ...base, content: dataUrl, previewUrl: dataUrl };
    }
    if (isTextLike(file.type, file.name)) {
      const text = await readAsText(file);
      return { ...base, textContent: text };
    }
    return { error: `不支持的类型「${file.name}」` };
  } catch (err) {
    return { error: `读取「${file.name}」失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('read failed'));
    fr.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error('read failed'));
    fr.readAsText(file);
  });
}
