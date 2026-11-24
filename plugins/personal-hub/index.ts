/**
 * personal-hub 插件：个人空间（自 Polaris 主仓 src/components/PersonalHub 迁移，纯插件实现）。
 *
 * 职责：
 * - panel 槽：个人空间面板（连接设置 → 登录/注册 → 导航/书签/待办列表）；
 * - 数据面：Supabase（auth=GoTrue REST，links=PostgREST），连接参数经 cap.config
 *   持久化（namespace=personal-hub），与 Polaris 桌面端同一 Supabase 项目时数据互通；
 * - 无 server 半边：Supabase 是公开云 API，浏览器直连（CORS 已由 Supabase 开放），
 *   不经宿主中转，避免把 anon key/访问令牌引入服务端日志。
 *
 * 原 Polaris 依赖面替换对照：
 * - @supabase/supabase-js → supabase.ts 手写 REST 极简客户端（auth + links CRUD）；
 * - crypto-js → crypto.ts WebCrypto EVP_BytesToKey + AES-CBC（密文与 crypto-js 互认）；
 * - lucide-react → ui.tsx 内联 SVG；
 * - zustand auth store → Panel.tsx 本地 state + localStorage 会话；
 * - configStore personalHub 字段 → cap.config（namespace=personal-hub）。
 */
import type { LitePlugin, SlotHostApi } from '@sdk';
import { setHostApi } from './store';
import { PersonalHubPanel } from './Panel';

export const personalHubPlugin: LitePlugin = {
  manifest: {
    id: 'personal-hub',
    name: '个人空间',
    version: '0.1.0',
    capabilities: ['cap.config'],
    provides: [],
    events: [],
    contributes: {
      // title ≤4 字：panel tab 等分宽约 74px，长名会截断
      slots: [{ slot: 'panel', component: 'PersonalHubPanel', order: 16, title: '空间' }],
    },
  },
  setup(api: SlotHostApi) {
    setHostApi(api);
  },
};

export { PersonalHubPanel };
export default personalHubPlugin;
