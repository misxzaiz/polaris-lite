/**
 * deploy-panel 插件：9826 分析实例的「一键部署」面板。
 *
 * 为什么需要它：9826 代码在独立 clone，升级只能显式发布；而人在 9826 对话里让
 * AI 跑 deploy 会把当前会话所在进程重启掉。这个插件把发布变成「点一下 → 后台跑
 * → 回来通知」，面板本身不参与构建。
 *
 * 三块职责：
 * 1. panel 槽「部署」：版本差距 / 进度 / 一键部署（Panel.tsx）；
 * 2. server 半边（server.mjs）：status / run / ack 三端点 + detached worker；
 * 3. 完成通知：9826 重启期间页面不在，所以不靠「推」而靠「重启后拉」——
 *    setup 起的 watcher 发现 last-run 未确认，就经 cap.ui.notify 补弹一次并 ack。
 *    这样即便当时关了页面，下次打开也会收到。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';
import { DeployPanel } from './Panel';
import './panel.css';

export { DeployPanel };

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
          body: '发布成功，本页刷新后即运行在新版本上。',
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
    version: '0.1.0',
    capabilities: ['cap.ui.notify'],
    requires: ['cap.ui.notify'],
    provides: [],
    events: [],
    contributes: {
      slots: [{ slot: 'panel', component: 'DeployPanel', order: 41, title: '部署' }],
    },
  },
  setup(api: SlotHostApi) {
    startNoticeWatcher(api);
  },
};

export default deployPanelPlugin;
