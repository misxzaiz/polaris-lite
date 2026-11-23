/**
 * 共享复制工具：所有插件统一走这里，禁止直接裸调 navigator.clipboard.writeText。
 *
 * 为什么必须有 execCommand 兜底（2026-11-23 复审结论）：
 * - Android System WebView 长期未实现异步 Clipboard API：`navigator.clipboard`
 *   常为 undefined，`writeText()` 直接抛 TypeError——APK 壳里所有复制按钮因此全部失效；
 * - 明文 http 源（手机连电脑 `http://IP:5000`）属非安全上下文，异步 API 同样不可用；
 * - `document.execCommand('copy')` 是同步旧 API，在上述两种场景仍然有效（配
 *   不可选中、脱离布局流的隐藏 textarea）。
 *
 * 返回 true/false，由调用方决定成功/失败反馈——**禁止 catch 后仍把 UI 置为「已复制」**。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 落到 execCommand 兜底 */ }
  return legacyCopy(text);
}

/** execCommand 兜底：隐藏 textarea + select + copy（须在用户手势调用栈内同步执行） */
export function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 脱离可视布局但保持可聚焦可选中；position:fixed 防止长文本撑出滚动条
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
