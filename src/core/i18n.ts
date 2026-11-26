/**
 * 核心壳层文案（最小实现）。
 *
 * 边界：这里只覆盖**宿主自己画的那几处**（顶栏 aria、启动告警、加载态）。
 * 插件内部文案由插件各自负责——核心不认识插件的领域词汇，也不该为它们准备 key。
 *
 * 为什么现在做：`SlotHostApi.t` 此前是 `t: (key) => key`，等于没有 i18n，
 * 而壳层同时写死中文。两件事叠加的结果是「看起来有 i18n，实际改不了文案」。
 * 现在 key → 文案只有这一处；将来接多语言时替换本文件的字典即可。
 */

const ZH: Record<string, string> = {
  'shell.appName': 'Polaris Lite',
  'shell.sessionList': '会话列表',
  'shell.capabilityPanel': '能力面板',
  'shell.loading': '正在载入',
  'boot.pluginLoadFailed': '插件加载失败',
  'boot.policyWarning': '权限告警',
  'boot.layoutBroken': '布局容器异常',
  'boot.startFailed': '应用启动失败',
  'boot.reload': '重新加载',
};

export function t(key: string): string {
  return ZH[key] ?? key;
}
