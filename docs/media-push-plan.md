# media-push 插件规划（通用媒体产物推送 · 任意文件类型）

> 需求（2026-11-28 小陈提出）：支持插件的工具在 AI 对话里给工具调用注册展示面板，
> 如图片、视频、Excel、音频等等，**任意类型都支持**。
> 现状：已有两个产物插件各管一角——image-push（图片）与 html-preview（HTML 面板）。
> 本文档记录把「推文件给用户看」泛型化为任意媒体类型的 spec 草案，实施前需评审。

## 0. 目标与边界

**目标**：AI 用一个（或一族）工具把本地任意文件推到对话，聊天流内出现可内联查看的卡片：
图片（已有）、视频、音频、Office/CSV/TSV 表格、PDF、文本/代码/日志、归档（zip 列目录）、
其余未知类型给下载卡。panel 槽提供产物列表架（复用 html-preview Panel 模式）。

**不做**（边界）：
- 不做内容转 base64 过模型——沿用「工具只传引用」纪律，大内容一律落盘 + URL。
- 不做云端转码：视频/音频用浏览器原生 `<video>/<audio>` 能力，转码不在范围。
- 不做 Office 完整还原渲染：xlsx/csv 走轻量表格视图（分页 + 排序 + 简单筛选），
  docx/pptx 只给「下载 + 元信息」卡。
- 不替换 image-push / html-preview：两者已稳定，media-push 补齐其余类型；
  image-push 的 `push_image` 是否收敛为 `push_media` 的别名，实施时再定。

## 1. 架构（对齐既有产物插件三段式，宿主零改动）

```
AI ──tool_call push_media──▶ agent-loop（noApproval：只读源文件+落盘副本，同 image-push）
   └─ server.mjs POST /api/media/push { path, cwd?, title?, sessionId? }
        ├─ 读文件 + 魔数嗅探（不信任扩展名，沿用 image-push 经验：
        │   .jpg 实为 WebP、xlsx 是 zip 头）
        ├─ kind 判定：image / video / audio / sheet / pdf / text / archive / other
        ├─ 尺寸闸：图片 25MB（同 image-push）；音视频 500MB；表格/文本 20MB
        └─ 落盘 <dataDir>/media-push/<uuid>.<嗅探ext> + metadata.json（kind/原路径/字节/时间）
   ↩ { ok, id, url, kind, mime, bytes, title }
   └─ emit 'artifact.created' { rendererType:'media', data:{ url, kind, mime, bytes, name } }
        ↘ chat-lite 通用 artifact 渲染 → MediaCard 按 kind 分发内联视图
```

关键点：**artifact 契约不新增字段**——还是 `{rendererType, callId, title, data}`，
kind 放在 `data` 里。chat-lite 渲染器查表（`CHANNEL_ARTIFACT_RENDERERS['media']`）、
工具名登记（`CHANNEL_ARTIFACT_TOOL_NAMES`）两条通道均已存在，**第二/第三个产物插件
零改 chat-lite 的机制已验证**（image-push 即先例）。

## 2. kind → 卡片形态

| kind | 嗅探依据（魔数） | 卡片 |
|---|---|---|
| image | PNG/JPEG/RIFF+WEBP/GIF/BMP/ftyp(avif/heic) | 同 image-push：点开缩放 |
| video | ftyp 品牌为 mp4/mov/m4v/webm/matroska | `<video controls>` + 下载 |
| audio | ID3/RIFF+WAVE/OggS/ftyp(m4a)/fLaC | `<audio controls>` + 波形位（可选后置） |
| sheet | zip 头且含 xl/（xlsx）或纯文本含 `\t`/`,` 多列（csv/tsv） | 内联表格：分页 50 行、列宽省略、下载 |
| pdf | `%PDF-` | `<iframe>` 内嵌 + 下载 |
| text/code | UTF-8 可解码且无二进制替换符 | 语法高亮代码卡（限前 N KB） |
| archive | `PK\x03\x04` / `Rar!` | 列目录树（前 200 项）+ 下载 |
| other | 兜底 | 下载卡 + 文件名/大小/mtime |

xlsx 解析放前端（MediaCard 内 lazy import 本地打包的解析器）还是服务端转 JSON，
实施时按包体积分辨——倾向服务端 `/api/media/:id/table?sheet=&offset=` 流式切片，
避免把整表塞进 artifact data 或前端一次性拉取。

## 3. 工具 descriptor（草案）

```
name: push_media
description: 把电脑上的任意文件发给用户查看：图片/视频/音频/Excel(csv/xlsx)/PDF/
  文本/压缩包等，对话中出现对应卡片。入参=文件路径（相对路径按当前工作区解析）。
  严禁传 base64/dataURI——大内容过参数会卡死流式通道，一律传路径。
parameters: { path: string(必填), title?: string }
```

多文件一次性推：`paths: string[]` 可选参数（同一批产出多个 artifact 块）。

## 4. 安全闸

- 魔数嗅探定 kind + 定落盘扩展名；GET 侧只认白名单扩展名（防穿越，同 image-push FILE_RE 模式）。
- video/audio 不给 `<video src>` 直出用户任意路径——一律经 `/api/media/:id/raw`（cookie 门禁）。
- sheet 的公式不执行：xlsx 只读 cell 值（ct/cached value），csv/tsv 纯文本解析。
- 文本卡对超长内容截断（前 256KB + 省略提示），防止 DOM 爆炸。

## 5. 验收口径

1. 对同一 xlsx 分别传 path 与伪造扩展名（.png），kind 均为 sheet——魔数说了算。
2. 20MB 视频 push 后手机端 `<video>` 可播、可下载；模型侧 stdout 只有引用摘要。
3. csv 10 万行：卡片默认渲染前 50 行，翻页走 API，不整表下发。
4. 卸载 media-push：宿主与其余插件照常，旧会话中 media 产物显示「渲染插件未启用」
   （BlockGroup 已有 fallback）——删除即降级试金石。
5. `npm run check:plugins` / `npm test` / `npm run build:plugins` 全绿。

## 6. 实施切分建议

- P0：server 半边（嗅探/落盘/直出）+ push_media 工具 + image/video/audio 三种卡
  （image 卡直接复用 image-push 的 ImageCard 样式语言）。
- P1：sheet 卡（csv/tsv 先行，xlsx 次之）+ panel 槽列表架。
- P2：pdf/text/archive 卡、多文件批量。

---

## 7. 交互面板（2026-11-28 需求补录）

> 小陈补充：这些卡片不只是静态展示——要支持**交互**，交互经 **cap 转发调用后端**；
> 是**非注册面板的临时展示**（不进工作区布局树、不注册 view），支持**全屏交互及退出全屏**。

### 7.1 定位：临时产物卡，不是注册面板

- 卡片生命周期 = 所在消息块的生命周期：跟随会话存档重放，不向 `cap.ui.layout` 提申请、
  不注册 `contributes.views`、不进工作区树。与注册面板（可被用户拖拽/持久化）明确区分。
- 卡片是**插件自带组件**（经 `CHANNEL_ARTIFACT_RENDERERS` 登记进 chat-lite 渲染），
  内部 DOM/交互完全自由——落在「插件内容层：完全自由」里，符合三层边界。

### 7.2 交互模型：卡内 UI → cap → 插件 server 半边

```
卡内按钮/表格翻页/筛选/播放器事件
  └─ cap 总线 dispatch（如 cap.media.table / cap.media.meta）
       └─ 插件 server 半边 HTTP 端点（cookie 门禁）
            ↩ JSON/流 → 卡片 setState 局部刷新
```

- 能力声明：插件 `provides: ['cap.media.table', 'cap.media.meta', ...]`，
  经 `api.registerCapability.register()` 挂 handler，走标准 cap 总线（resolvePolicy 可审计），
  **不另开暗通道**。
- 交互请求的数据同样只传引用（mediaId/行号区间），不把大 payload 经模型或参数通道搬运。
- 交互是「卡片 ↔ 后端」直连，不回模型：翻页、排序、播放进度这类高频操作不打扰对话流。

### 7.3 全屏（复用 html-preview 伪全屏方案）

- 沿用 `enterPseudoFullscreen / exitPseudoFullscreen / onPseudoFullscreenChange`
  （Popover top layer 伪全屏，不 requestFullscreen、不动 DOM 结构——三个死方案见
  `plugins/html-preview/fullscreen.ts` 头注释）。media-push 直接复用该模块或抽到 @sdk 共享。
- 标题栏含「全屏/退出全屏」按钮，进入全屏后交互区（表格/播放器/画布）占满，Esc 退出。
- 全屏态保活：卡片组件不卸载（只挂属性切层），iframe/播放器/表格状态天然保留。

### 7.4 各 kind 的交互点

| kind | 卡内交互（cap 转发后端） |
|---|---|
| sheet | 翻页/排序/筛选/切 sheet 页（cap.media.table 切片）、导出 csv |
| video / audio | 播放控制（原生控件）、倍速、跳转时间点 |
| archive | 目录树展开/懒加载（cap.media.listentries） |
| text/code | 折叠展开、复制、跳行 |
| other | 下载（直链，无 cap） |

### 7.5 验收补条

6. 卡内翻页请求走 cap dispatch（network 面板可见统一 /api/cap 入口），不经模型；
   拔掉插件 server 半边，卡片交互降级为只读 + 错误提示，不崩会话。
7. 任意卡进入全屏 → 交互正常 → Esc/按钮退出 → 回到消息流原位，播放进度/表格页码保留。
8. 卡片不出现在工作区布局树与 panel tab 里（非注册面板的判定）。
