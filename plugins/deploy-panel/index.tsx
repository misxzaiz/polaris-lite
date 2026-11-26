/**
 * deploy-panel 插件：9826 分析实例的「一键部署」。
 *
 * 前端 panel 半边已并入 app-updater 的「版本」统一面板（VersionPanel：
 * 版本链路图 + 状态机主按钮），本文件只保留：
 * 1. server 半边（server.mjs，server-registry.mjs 单独登记）：status/run/ack
 *    三端点 + detached worker —— 契约零改动；
 * 2. 完成通知 watcher（setup 起的轮询）：9826 重启期间页面不在，所以不靠
 *    「推」而靠「重启后拉」——发现 last-run 未确认就经 cap.ui.notify 补弹一次
 *    并 ack。这样即便当时关了页面，下次打开也会收到。
 *
 * 通知里带「刷新到新版本」的引导文案，与 app-updater 的更新闭环衔接。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';

const short = (sha?: string | null): string => (sha ? sha.slice(0, 7) : '—');

/**
 * 完成通知 watcher：轮询 /api/deploy/status 的 notice 字段。
 *
 * 端点未启用（404）或未登录（401）时静默——9825 生产就没有这个端点，
 * 插件被误发布过去也只是什么都不发生。
 */
function startNoticeWatcher(api: SlotHostApi): void {
  if (typeof window === 'undefined') return;
  let inFlight = false;
  let stopped = false; // 404 = 本实例没有部署端点（9825 生产），不必再轮询

  const check = async (): Promise<void> => {
    if (stopped || inFlight || document.visibilityState !== 'visible') return;
    inFlight = true;
    try {
      const res = await fetch('/api/deploy/status', { cache: 'no-store' });
      if (res.status === 404) {
        stopped = true;
        return;
      }
      if (!res.ok) return;
      const st = (await res.json()) as { notice?: { id: string; sha?: string | null } | null };
      const notice = st?.notice;
      if (!notice?.id) return;
      await api.dispatch({
        target: 'cap.ui.notify',
        action: 'notify',
        payload: {
          title: `9826 已更新到 ${short(notice.sha)}`,
          body: '发布成功；到「版本」面板刷新页面即可运行在新版本上。',
          level: 'success',
          dedupeKey: `deploy:${notice.id}`,
          source: 'deploy-panel',
        },
      });
      await fetch('/api/deploy/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: notice.id }),
      });
    } catch {
      // 9826 正在重启：网络断，下一轮再来
    } finally {
      inFlight = false;
    }
  };

  void check();
  window.setInterval(() => void check(), 15_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
}

export const deployPanelPlugin: LitePlugin = {
  manifest: {
    id: 'deploy-panel',
    name: '部署',
    version: '0.2.0',
    capabilities: ['cap.ui.notify'],
    requires: ['cap.ui.notify'],
    provides: [],
    events: [],
    contributes: {
      slots: [], // 前端面板并入 app-updater「版本」Tab；本插件只剩 server 端点 + 通知 watcher
    },
  },
  setup(api: SlotHostApi) {
    startNoticeWatcher(api);
  },
};

export default deployPanelPlugin;
