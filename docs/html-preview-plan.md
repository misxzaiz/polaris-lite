# html-preview 插件规划（AI 生成 HTML 交互面板 · polaris-lite 版）

> 来源：Polaris 主仓 `interactive-component` v2.1.0 的 lite 移植 + 六项改进。
> 本文档即 spec（目标/边界/接口/验收），实施照此执行。

## 0. 目标与边界

**目标**：AI 在对话中调 `render` 工具生成自包含 HTML 交互面板（小游戏/原型/教具/图表页面），
对话流内渲染沙箱卡片（展开/全屏/状态保留），panel 槽提供持久应用架（列表/运行/全屏），
刷新不丢。纯插件实现：宿主零改动，chat-lite 只做一次 artifact 泛型化改造。

**不做**（边界）：
- 不做 three.js vendor 注入（v1；descriptor 明示 AI「不引 CDN、3D 需求用 base64 内联简化实现」）
- 不做闪造联动（lite 无闪造）
- 不做 MCP stdio（lite 工具走 cap 总线 + HTTP 中间件）
- interactive 的 question/form/confirm 不迁移到 artifact 块（已交付语义自洽，避免无收益返工）
- 不提供删除/管理界面（配额自动淘汰，管理走文件系统）

## 1. 架构（对齐 lite 既有范式）

```
AI ──tool_call render──▶ agent-loop（免审批分支）
   └─ dispatch cap.tool.render {action:'render', html,title,basePreviewId?,sessionId,messageId}
        └─ html-preview UI 半边 handler
             └─ fetch POST /api/preview/render（服务端扫描+落盘+配额）
                  ↩ {previewId, version, versionLabel, url}   ← 只回引用，不回 HTML
             └─ emit 'artifact.created' {rendererType:'html-preview', callId=previewId,
                  title, data:{previewId,url,versionLabel}, sessionId, messageId}
                  ↘ chat-lite 通用 artifact 监听 → 落 {type:'artifact'} 块
                     → BlockGroup 经 __PLITE_ARTIFACT_RENDERERS__[rendererType] 渲染卡片
        ↩ agent-loop 拿到 {previewId,...} 以 [预览已生成] 喂回 shadow，模型继续
```

**卡片 iframe 源**：`GET /api/preview/:id/raw`（响应头强制 CSP sandbox，见 §4）。

## 2. 插件文件

```
plugins/html-preview/
├── index.ts        # UI 半边：cap.tool.render 注册 + 渲染器登记 + Panel 导出 + manifest
├── PreviewCard.tsx # 对话卡片：标题栏(AI生成徽标/标题/版本) + iframe + 展开toggle + 全屏
├── Panel.tsx       # panel 槽应用架：GET /api/preview/list 持久列表 + 运行 + 全屏
├── panel.css       # 卡片+面板样式（复用 tc-ia 容器语言、lite token）
├── server.mjs      # 服务端半边（server-registry 登记）
├── vite.config.ts  # createPluginConfig('html-preview', './index.ts', 'dist')
└── package.json
```

## 3. 服务端 API（全部会话 cookie 门禁；PLITE_PREVIEW=0 一键禁）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/preview/render` | POST | `{html, title?, basePreviewId?}` → `{previewId, version, versionLabel, url, bytes}`；扫描闸 → 落盘 `<dataDir>/previews/<uuid>/index.html` + metadata.json |
| `/api/preview/:id/raw` | GET | 返回 index.html，**响应头** `Content-Security-Policy: sandbox allow-scripts allow-forms allow-pointer-lock; ` + `X-Content-Type-Options: nosniff` + `Content-Type: text/html; charset=utf-8` |
| `/api/preview/:id/meta` | GET | metadata + html（AI 迭代回读用，也供卡片「复制源码」） |
| `/api/preview/list` | GET | `?limit=50` 落盘目录实读，按 createdAt 倒序；供 Panel 持久化 |

**扫描闸**（stripComments 后跑；对齐原版 12 条 + 注释剥离改良）：
fetch( / XMLHttpRequest / WebSocket / EventSource / sendBeacon / serviceWorker /
动态 import( / window.open( / top.location|parent.location / document.domain /
外链 `<script src>`（非 data:）。

**闸的边界（如实声明）**：静态扫描可被拼接绕过（`window['fe'+'tch']`）——它只是第一道，
**硬边界是 CSP sandbox 头 + iframe sandbox 属性**（不透明 origin：无 cookie、无同源存储、
无宿主 API 资格）。扫描闸的价值是拦「AI 无恶意但习惯性写 CDN 外链/fetch」的主流场景。

**配额**：previews 目录 ≤200 个，超限按目录 mtime 淘汰最旧；单 HTML ≤2MB。

**previewId**：服务端 crypto.randomUUID() 生成，AI/客户端不可指定——天然防路径穿越；
raw/meta/list 校验格式（uuid 正则）后才拼路径。

## 4. 安全模型（双层硬边界）

1. **iframe**：`sandbox="allow-scripts allow-forms allow-pointer-lock" allow="autoplay"`
   （无 allow-same-origin → 不透明 origin）
2. **顶层导航**（用户直接开 /raw URL）：`Content-Security-Policy: sandbox allow-scripts
   allow-forms allow-pointer-lock` 响应头让顶层文档同样落入沙箱 origin
   （CSP sandbox 对顶层导航生效）——修掉原版「直开 URL 时跑真实 origin」的洞。
3. 写入面：只有 /render 落 previews 目录；配额淘汰；无任何读任意路径接口。
4. 视觉欺骗压制：卡片/面板常驻「AI 生成」徽标（--accent token 色条），输入类内容自带此提示。

## 5. agent-loop 分支（第三类工具）

- `discoverTools` 无需改（cap.tool.* 前缀自动发现）
- 执行循环加分支：`desc.cap === 'cap.tool.render'` → **免审批**（同 interactive：
  HTML 惰性、写入面锁死、沙箱硬边界；迭代连改 5 版弹 5 次审批是 UX 灾难）
- dispatch `{action:'render', payload:{...safeArgsRender(call.arguments), sessionId, messageId: assistantId}}`
- `safeArgsRender`：只透传 html/title/basePreviewId（html ≤2MB 截断交服务端拒）
- 返回喂 shadow：`[预览已生成] {previewId,url,versionLabel,title}`；失败 `[预览生成失败] <error>`
- system prompt 增补一句 render 指引（何时用/自包含/不联网约束）
- manifest.capabilities 加 'cap.tool.render'；grants 同步

## 6. chat-lite artifact 泛型化（一次性改造，后续可视化插件零改动）

- AsstBlock 加第 4 类：`{type:'artifact'; card: ArtifactCardData}`
  ```ts
  interface ArtifactCardData {
    callId: string;          // = previewId（幂等去重键）
    rendererType: string;    // 'html-preview' | 未来其它
    title: string;
    status: 'ready' | 'error';
    data: Record<string, unknown>;  // 渲染器私有载荷（url/versionLabel...）
  }
  ```
- store：appendAssistantBlock 已按类型保真（interactive 交付时修过）→ 无需改；
  patch 不需要（artifact 一次性落块，无回填流）
- BlockGroup：`b.type === 'artifact'` → 查 `__PLITE_ARTIFACT_RENDERERS__[rendererType]`，
  未登记渲一块兜底提示（不崩、不空白）
- 通用监听：setup 里 `api.listen('artifact.created', ...)`（同 onInteractive 模式，
  按 sessionId/messageId/callId 定位落块，created 幂等）
- manifest.events 加 'artifact.created'；grants 同步
- **html-preview 是第一个渲染器**：setup 时 `__PLITE_ARTIFACT_RENDERERS__['html-preview'] = PreviewCard`

## 7. UX 细节（防突兀清单）

- 卡片复用 tc-ia 容器语言：左侧 accent 色条 + 标题栏（徽标「AI 生成」+ title + versionLabel）
  + 操作钮（展开 360px↔70vh / 全屏）；样式进 html-preview 自带 panel.css（不改 chat.css，
  渲染器自带样式，符合「插件自带样式」惯例）
- **全屏 = 卡片容器加 `position:fixed; inset:0; z-index` 类**（节点不动，iframe 不重载，
  状态保留——修原版双实例丢状态问题；lite 消息流无 transform 祖先，fixed 可逃逸）
  顶栏加「退出全屏」按钮；Esc 退出
- Panel：tab 名「预览」；空态引导「在对话中让 AI 用 render 生成一个 HTML 页面试试」；
  列表项 = 标题+版本+时间；点击右侧 iframe 区运行；「全屏运行」同卡片全屏机制
- 图标 SVG 细线；禁 emoji/符号字符
- 操作钮 hover 才显示（E2E 用 dispatchEvent 点击）

## 8. 权限面（grants 增量）

```json
"html-preview": { "capabilities": [], "provides": ["cap.tool.render"],
  "events": ["artifact.created"] }
```
- chat-lite.events += 'artifact.created'
- agent-loop.capabilities += 'cap.tool.render'

## 9. 验收

1. `npx tsc --noEmit` + `tsc -p tsconfig.plugins.json` 全绿
2. `node plugins/build-plugins.mjs`（14 插件）+ `--check` 通过
3. vitest 全量 ≥148 基线 + 新增 preview-server.test.mjs：
   - 扫描闸：拦 fetch/外链 script src；放行字符串里提"fetch"的注释样本；拦 `window['fe'+'tch']` 不强求（如实声明可绕过）
   - raw 响应头 CSP sandbox 断言
   - 配额淘汰（>200 丢最旧）
   - previewId 非法格式 400
4. CDP E2E：发「用 render 工具画一个贪吃蛇小游戏」→ tool 卡 → artifact 块出现 →
   iframe 内有 canvas → panel 列表出现该应用 → 全屏/退出 iframe 状态保留 →
   刷新页面 panel 列表仍在
5. 安全冒烟：直接开 /raw URL，`document.origin` 为 "null"（opaque）
6. E2E 后数据根恢复（mode='confirm'、roots 清空、auth-owner 删除纪律照旧）

## 10. 决策记录（已定案）

| 决策 | 结论 | 理由 |
|---|---|---|
| HTML 回传 | previewId 引用制 | token 与 localStorage 1.5MB 容量双约束下必需 |
| 审批 | render 免审批 | 惰性内容+沙箱硬边界+写入面锁死；迭代 UX |
| 全屏 | 原地 fixed 类 | iframe reparent 会重载（Chrome 实测行为），状态保留 |
| 落盘 | `<dataDir>/previews/` | 应用架跨会话可见；与 providers.json 同级 |
| 工具名 | render | lite 单词惯例（bash/files/interactive） |
| 三档 iframe 权限 | 删，统一单档 | AI 不可自选权限（原版 source 参数缺陷） |
| three.js | v1 不做 | 820KB vendor 体积/构建复杂度；后续按需 |
| artifact 泛型 | 做 | 第二个可视化插件起回本；chat-lite 不再长 |
