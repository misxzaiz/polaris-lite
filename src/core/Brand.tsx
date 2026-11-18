/**
 * 品牌件（细线极简星标 + 字标）。
 *
 * 单独成文件的原因：锚点现在由工作区树渲染，侧栏锚点需要它，而 SlotLayout 又引用树，
 * 放一起会形成循环依赖。
 */

export function BrandMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path
          d="M16 2.5 18.8 13.2 29.5 16 18.8 18.8 16 29.5 13.2 18.8 2.5 16 13.2 13.2 16 2.5Z"
          stroke="currentColor"
          strokeWidth="1.15"
        />
        <path
          d="M16 9.5 17.35 14.65 22.5 16 17.35 17.35 16 22.5 14.65 17.35 9.5 16 14.65 14.65 16 9.5Z"
          fill="currentColor"
          fillOpacity="0.22"
        />
      </svg>
    </span>
  );
}

export function Brand() {
  return (
    <div className="shell-brand">
      <BrandMark />
      <span className="brand-copy">
        <span className="brand-name">Polaris</span>
        <span className="brand-edition">Lite · Private Intelligence</span>
      </span>
    </div>
  );
}
