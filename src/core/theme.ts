/**
 * 壳层主题色常量（浏览器 UI 配色，如移动端地址栏 theme-color）。
 *
 * 为什么单独成文件：此前 SlotLayout / hostRuntime 各写一份 `#0b0b0d / #ffffff`，
 * 与 plite-tokens.css 的 `--bg` 是三处独立事实源，改主题必然漏一处。
 * 这里作为 JS 侧唯一出处；tokens 的 `--bg` 保持语义一致（tokens 注释亦指向本文件）。
 */
export const THEME_COLORS = {
  light: '#ffffff',
  dark: '#16161a',
} as const;

export type ThemeMode = keyof typeof THEME_COLORS;
