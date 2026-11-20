# polaris-lite 手机 App 版方案（plan v2.2，2026-11-20）

> 目标：给出 polaris-lite「手机 app 版」的落地路线，覆盖三层需求——①手机获得接近原生 App 的使用体验；②手机可作为**电脑 AI 的传感器与遥控器**（电脑 AI 能看手机内容、操作手机）；③手机**可独立使用**（无电脑时有自洽的 App 形态，聊天与手机侧能力完整）。
> 定位：**分析+方案**（本文档本身即交付物；分阶段条目另行立项实施）。
> v2 变更：应「要支持连电脑用电脑、也要能手机独立用、电脑 AI 能看手机内容」升级需求，新增 §9（手机端点=被电脑 AI 看/操作）与 §10（手机独立 App 档），并修订形态定案为「一仓三档」。
> v2.1 变更：用户定案——连接方式=手填电脑服务地址（不做扫码），保留账号密码登录；`cap.tool.phone` 配对模型简化为「登录即身份」。
> v2.2 变更：用户问「能不能纯插件实现」——§11 逐项审计定案**纯插件路线**：新增 install-guide/standalone-mode 插件，宿主仅落 P0 静态资产（manifest/icons/sw.js），`src/core/` 预期零改动。
> 关联：`docs/chat-multi-device-sync-plan.md`（多设备共享会话，App 化的前置依赖）；`docs/server-gateway-contract.md`（未来第三方插件的权限地基）。

---

## 1. 需求与边界

| # | 需求 | 说明 |
|---|---|---|
| R1 | 手机可安装 | 手机上出现独立图标，点开即用，不经过「打开浏览器→输网址」 |
| R2 | App 化观感 | 全屏/独立窗口（无浏览器地址栏与标签页）、有自己的任务栈与启动画面 |
| R3 | 不破坏 lite 架构 | 宿主零业务、双入口插件体系、cap 总线、server-registry 装配均不变 |
| R4 | 不新增维护面 | 不引入第二套前端构建/第二种服务端运行时；单一代码库继续产 web |
| R5 | 演进留路 | 今日方案不堵死「真离线 App」（无局域网/无服务器也可用）的未来 |
| R6 | 手机是电脑的外设（v2 新增） | 电脑上的 AI 能读取手机内容（剪贴板/相册/文件/页面文本/截屏）并把手机当作其工具（`cap.tool.phone`） |
| R7 | 手机独立可用（v2 新增） | 无电脑时手机 App 自洽：本地登录态、本地会话、可直连云供应商聊天、手机侧工具完整 |

**本方案明确不做**（做不了/不值的都写清，避免反复讨论）：

- 不做「手机上跑 Node 服务端」来承接完整宿主职责——agent-bash/agent-files/browser-lite 等要的是**宿主机**的文件系统与进程，手机本体跑这些没有意义（这不是「手机连电脑」，是「手机变电脑」，超出 lite 定位）。但手机**要跑一个薄端点**承接手机侧能力（§9），这与「跑完整宿主」是两回事。
- 不做双端推送（Web Push/APNs）——需要常驻 Service Worker + VAPID + 各浏览器推送服务，单 owner 场景收益低，留待真需要时单独立项。
- 不做 App Store / Play 商店上架——单 owner 自用形态，分发成本完全不成比例；侧载/MDM 以后再说。
- 不做 iOS 深度自动化（无障碍 API 读取第三方 App 屏幕等）——iOS 平台不允许，Safari 截屏也要走共享相册导出；§9 能力矩阵按平台如实标注，不承诺 iOS 奇迹。
- 不重写任何 UI——手机适配（≤768px 单栏、抽屉侧栏、safe-area、16px textarea、≥40px 触摸目标）2026-11-18 已全部落地并冒烟通过。

## 2. 现状基线（已具备，勿重复建设）

盘点结论：**polaris-lite 距离「手机 App」只差一层壳 + 两个连接方向；业务与适配全部就绪。**

| 维度 | 现状 | 对 App 化的意义 |
|---|---|---|
| 移动端 UI | ≤768px 单栏化 + 抽屉侧栏 + safe-area + dvh + 防聚焦放大，375×812 冒烟通过 | 无需任何新适配 |
| 会话数据 | 服务端权威（chat-store，版本化整写 + 索引轮询，spec 见 `docs/chat-multi-device-sync-plan.md`） | 手机与桌面天然看同一份会话 |
| 鉴权 | 单 owner + HttpOnly cookie 会话（12h）+ MD5→scrypt 链路 + 登录限速 | 多设备=同账号多 sid，App 与浏览器并存无冲突 |
| 供应商密钥 | 服务端持有（relay 内嵌 `/api/model-relay`），前端零密钥 | 手机连电脑形态下密钥永不落手机，丢了不泄 |
| AI 工具体系 | agent-loop 经 `cap.tool.*` describe 协议聚合工具（cap.tool.fs/bash/browser/files-write/render…），新工具注册即自动进 AI 工具集 | **`cap.tool.phone` 是纯新增点，零改动 agent-loop**（§9） |
| 部署形态 | 单端口 Node（`npm run build && npm start`，9825）+ dev:standalone（5000） | 两个连接方向的信令枢纽都是它 |
| PWA 资产 | **缺**：无 `manifest.webmanifest`、无 Service Worker、无 apple-touch-icon/图标资源 | 这是 P0 要补的全部前端工作量 |
| 插件数据 | kv-store 服务端 sqlite，禁 localStorage（AGENTS.md 纪律） | App 化后数据不落浏览器，清缓存不丢 |

**网络现实**：手机与宿主机的连通性三种情形，方案必须分别覆盖：

1. 同一局域网（家里/办公室 Wi-Fi）——常态，直连即可；§9 的局域网 mDNS 发现也依赖它；
2. 跨网络（外出访问家里）——已实测过的公网 IP + 端口方式（2026-11-18 内网穿透适配，vite host 0.0.0.0 + 同源 `/relay`）；后续可换 frp/tailscale/Cloudflare Tunnel，服务端零改动；
3. 完全离线——只有手机独立档（§10）能覆盖；连接档（A1/A2）此时降级为「缓存壳 + 明确的不可达提示」。

## 3. 形态定义（v2：「一仓三档」，R6/R7 各归其位）

手机 App 版分三档，**同一代码库、同一套插件契约，三档只是运行模式与能力档位不同**：

| 档 | 形态 | 离线 | 电脑 AI 看手机 | 工作量 | 适合 |
|---|---|---|---|---|---|
| **A1** | 手机浏览器/壳连接宿主使用（同源 PWA + §9 手机端点） | 不可用 | **✅（§9）** | 小（P0+P1+P3） | 日常主推 |
| **A2** | A1 + 分发侧打包（shortcut/MDM/企业分发） | 不可用 | ✅ 同 A1 | 追加小 | 不想手输网址的场景 |
| **B** | 手机独立 App：本地会话 + 可选直连云供应商 + 手机侧工具；与宿主相遇时升级为连接档 | **可用** | 仅相遇时 | 大（P4，分多步） | 没有常开宿主机时的主力 |

**三档关系**——这是 v2 定案的关键，与 v1「B 另行立项」不同：

- **连接优先，独立兜底**：A1 先行落地（工作量最小、价值最大），B 在 A1 的壳与资产上增量长出，不推倒。
- **能力差异在服务端半边，不在前端**：连接档的会话/工具编排全在宿主 Node（agent-loop 在宿主跑，AI 才能用 bash/browser）；独立档把「会话存储 + 模型中继 + 轻量编排」三件事换成本地实现（§10.3），前端 chat-lite 界面零改动。
- **升级/相遇语义**：独立档 B 启动时探测到宿主可达（曾配对过的地址），提示「发现你的电脑，切换为连接模式」——同一账号，会话归属随模式走（独立档本地会话可选上收宿主，走 chat-store 既有 PUT 通道，冲突由 baseVersion 409 兜底）。

**仍然不做**（与 §1 呼应）：手机跑完整宿主（bash/browser-lite 等宿主侧工具不会出现在手机上）；iOS 深度自动化；双端推送；商店上架。

## 4. P0：同源 PWA 基建（前端一次性补齐）

让「添加到主屏幕」在 iOS/Android 上都产出**独立全屏窗口**而非浏览器书签。全部是静态资产，落 `public/`，随 dist 分发：

| # | 项 | 说明 |
|---|---|---|
| P0-1 | `public/manifest.webmanifest` | `name/short_name/display:standalone/orientation:portrait-primary/theme_color/background_color`；`start_url` 用 `?source=pwa`（区分统计，不做也行）；**scope 必须是 `/`**（否则 manifest 里的相对路径解析错位） |
| P0-2 | `index.html` 补链接 | `<link rel="manifest">` + `apple-touch-icon`（iOS 必需，无 manifest 也不影响 iOS）+ `apple-mobile-web-app-capable` / `mobile-web-app-capable` meta；`theme-color` 已有 |
| P0-3 | 图标资产 | 512/192 两档 PNG + maskable 变体；源用现有 `src/core/Brand.tsx` 视觉导出（不复用 Polaris 主仓图标，两产品线区分） |
| P0-4 | Service Worker（**仅缓存壳**） | `sw.js`：`navigate` 请求 network-first（在线=新鲜，离线=上次壳），静态 assets stale-while-revalidate，**API 一律不缓存**。注意 vite build 带 hash 的 assets 文件名每次构建变化，SW 缓存清单要在 `install` 期用 `self.__WB_MANIFEST` 式注入或编译期生成（不引 Workbox 的话写个小 `scripts/gen-sw-manifest.mjs` 挂进 `npm run build`） |
| P0-5 | 安装引导（可选，插件形态） | `beforeinstallprompt`（Android Chrome）捕获后出「安装」气泡；iOS 无事件，登录视图下方出一次性「分享→添加到主屏幕」指引条（localStorage 记忆已隐藏） |

**验收**：Android Chrome 与 iOS Safari 各自加桌后——点图标开独立全屏窗口；`display-mode: standalone` 下 UI 无异常（抽屉/键盘/安全区回归）；杀网刷新出缓存壳而非恐龙页；在线全功能（发消息/工具卡/面板）冒烟通过。

**红线**：不动 bus/鉴权/插件契约；SW 永不缓存 `/api/*` 与 `/api/model-relay`（否则出现陈旧会话/陈旧密钥的诡异态，难排查）。

## 5. P1：手机侧连接配置（用户定案：填地址 + 账号密码登录）

解决「壳里的服务器地址与身份从哪来」。**用户定案（2026-11-20）：手填电脑服务地址连接即可，扫码等增强不做；保留账号密码登录。**

| # | 项 | 说明 |
|---|---|---|
| P1-1 | **首启两步引导：填地址 → 登录** | ①引导视图输入宿主 `host:port`（如 `192.168.1.100:9825`）；②跳转到该地址加载应用，进入**既有登录视图**输入 owner 账号密码。两步都是宿主壳层视图，非插件 |
| P1-2 | 地址的技术语义（重要，写死避免做歪） | 同源 PWA 安装自宿主 origin，地址天然内嵌——浏览器里输一次地址→加载→「添加到主屏幕」，App 此后永远开这个 origin。**应用内的地址字段 = 跳转重新加载**（`location.assign('http://<新地址>/')`），不做「仅切 API base 不换页」的跨域形态（那要求宿主开 CORS、cookie 跨域、SW 作用域全跟着改，收益为零）。宿主 IP 变了（DHCP）→ 设置里改地址 → 跳转即可 |
| P1-3 | 登录即既有体系，零新增 | 手机登录用的就是**同一个 owner 账号密码**（auth-session 单 owner + HttpOnly cookie 12h + MD5→scrypt 链路 + 登录限速，全部现成）；登录视图手机版已随移动适配就绪。不引入第二个账号、不做手机专属鉴权 |
| P1-4 | 连接状态与重连提示 | standalone 窗口无地址栏，宿主不可达时要有明确「连不上电脑（检查电脑是否开机/同一 Wi-Fi）」+「修改服务器地址」入口，不白屏（依赖 P0-4 缓存壳） |
| P1-5 | 跨网访问文档 | `docs/deploy-mobile.md`：三种连通方式（局域网直连/公网 IP/隧道）、`secureCookies` 与 HTTPS 的关系（公网 IP HTTP 下 SW 不注册、cookie 不 Secure，必须隧道+TLS；局域网 IP 属 secure context 豁免，纯 HTTP 可用） |
| P1-6 | 扫码（**暂缓，可选增强**） | 桌面出二维码免手机输 IP——用户定案不需要；若将来 IP 频繁变化再考虑（实现时复用 qr-desk 二维码 + 一次性 token 先例） |

**验收**：手机连宿主所在 Wi-Fi → 首启引导输地址 → 登录账号密码 → 全功能；杀进程重开 App 免输地址（PWA origin 内嵌）+ 12h 内免登录（cookie）；宿主关机后打开 App 显示可达性提示 + 修改地址入口。

## 6. P2 → §10（真离线 App 的演进路，路线改道说明）

v1 的 §6（真离线 App「另行立项」）在 v2 升格为正式档位 B（§10）——R7（手机独立使用）把它从「可选兜底」变成「需求项」。路线不变的部分在此保留：

- **前端全量离线**：P0-4 的 SW 已经缓存全部静态资产，离线时壳是完整的——缺的是数据面。
- **会话离线**：chat-store 已是「服务端权威 + 本地缓存」结构；「离线可写」需引入本地写队列+补偿上传（sync spec 留了此演进方向）。
- **打包**：若最终要 APK/IPA 真包，Polaris 主仓移动线已有 JKS 签名与发布通道（记忆 `polaris-android-apk-build-status`），Capacitor 壳可复用该签名体系；不属于 lite 仓工作。

## 7. 风险与坑（提前写清）

| 风险 | 影响 | 对策 |
|---|---|---|
| iOS PWA cookie 7 天丢弃 | iOS 上 standalone 窗口的 cookie 可能被 WebKit 更激进回收，表现为「隔几天要重新登录」 | 已有 12h 会话期本来就常重登；真在意时上「记住我」长效 token（auth-session.mjs 加可选 remember-me） |
| vite build hash 与 SW 缓存清单漂移 | 新版本发布后旧 SW 继续喂旧 assets，前端半边与插件 API 错配 | SW navigate network-first 保证壳新鲜；assets 用编译期生成的清单（P0-4）；插件产物本就禁强缓存（prod-server 注释明示） |
| 公网 IP 直连 HTTP | SW 不注册、cookie 不 Secure、明文传输 | 文档强约束走隧道+TLS；`secureCookies` 开关已备 |
| 手机输入法顶起布局 | standalone 下 `interactive-widget=resizes-content` 行为差异 | 现有视口配置已含 `interactive-widget`，验收清单单列一条输入回归 |
| 双实例（浏览器 tab + App）同时在线 | 会话写冲突 | chat-store 的 baseVersion 409 机制已覆盖，App 形态无新增风险 |
| 手机休眠掐长连接（§9） | iOS 后台几十秒即冻结 JS，SSE 连接断，电脑 AI 调 `cap.tool.phone` 落空 | 工具契约含 `online`/`lastSeen`（§9.2），AI 收到「设备离线」语义而非挂死；前端恢复前台时自动重连 |
| 局域网发现跨网段失败 | mDNS 被路由器 AP 隔离（访客网络）拦掉 | 手填地址兜底永远是第一入口，发现只是锦上添花 |

## 8. 落地路线与工作量预估（v2 修订）

| 阶段 | 内容 | 预估 | 前置依赖 |
|---|---|---|---|
| P0 | manifest+icon+SW+安装引导 | 1 个会话 | 无（纯前端静态资产 + build 脚本小改） |
| P1 | 首启引导（填地址→账号密码登录）+ 可达性提示 + 部署文档 | 1 个会话 | P0；登录/会话体系全现成 |
| P3 | 手机端点与 `cap.tool.phone`（§9）：phone-agent 插件 + phone-gateway server 半边 + 登录即配对 | 2~3 个会话 | P1；与 P4 无依赖关系，可并行 |
| P4 | 手机独立档（§10）：独立运行模式 + 本地会话 + 直连供应商 + 相遇升级 | 3~4 个会话（分步） | P0；P4-3 直连受 CORS 逐端点验证（历史教训：Moonshot 曾拦 OPTIONS 404） |

实施纪律：P0/P1/P3/P4 均遵守 lite AGENTS.md——开发在 5000 端口验证，不动 9825 生产数据；新插件一律走双入口契约（`plugins/build-plugins.mjs` + `plugins/server-registry.mjs` 登记）。

---

## 9. P3：手机端点——让电脑 AI 看手机、用手机（v2 新增，R6）

「用电脑的 AI 看手机内容」的架构定案：**手机不再是浏览器里的被动 UI，而是一个可被发现、可被调用能力端点（endpoint）；宿主是能力总线的唯一权威，`cap.tool.phone` 是 AI 侧的统一门面。**

### 9.1 为什么不让 AI 直接推指令到手机，而是手机当端点

三个候选路线的取舍：

| 路线 | 描述 | 否决/采纳理由 |
|---|---|---|
| ① AI 直推（宿主→手机单向推送指令） | 宿主把工具调用结果直接推给手机执行 | ✗ 手机永远在线假设不成立（休眠即丢指令）；且与「手机主动上报」语义冲突 |
| ② 手机全量上云（内容先同步到宿主，AI 再读） | 手机内容定时推宿主 | ✗ 隐私/流量/电量三输；AI 要的是「现在」的剪贴板，不是 5 分钟前的快照 |
| ③ **手机=端点，宿主=信令枢纽**（采纳） | 手机长连接（SSE）挂在宿主上，声明能力清单；AI 调 `cap.tool.phone` → 宿主下发指令 → 手机执行 → 结果回宿主 → 回 AI | 与 lite 既有模型同构：这就是「agent-bash 之于宿主机」的镜像——工具实现在哪端，哪端就是执行者；宿主只做门面、鉴权与审计 |

③ 的本质：把 `cap.tool.bash`（在宿主机执行）的模式复制到手机（在手机执行），agent-loop 的 describe 协议零改动，AI 眼里只是多了一个 `phone` 工具。

### 9.2 架构与连接拓扑

```
电脑（宿主 Node :9825）                        手机（PWA/App，独立档或连接档均可）
┌────────────────────────────┐   SSE 长连接    ┌──────────────────────────────┐
│ agent-loop（编排不变）        │◀──────────────▶│ phone-agent 插件（前端半边）    │
│   └ cap.tool.phone/describe │                │  - 维持 SSE + 心跳(15s)        │
│   └ cap.tool.phone/exec     │  指令下行/结果上行 │  - 能力清单注册（登录确认时上报）  │
│        │                    │                │  - 执行器：剪贴板/相册/文件/…   │
│ phone-gateway（server 半边）  │                │  - 前台保活提示（休眠=离线）     │
│   - 设备注册表(登录会话绑定)     │                └──────────────────────────────┘
│   - 指令路由/超时/审计         │
└────────────────────────────┘
     ▲
     │ AI 工具调用（既有 cap 总线，零新概念）
┌────┴─────────┐
│ AI（宿主模型） │——「看看我手机剪贴板/把这个文件发到手机相册」
└──────────────┘
```

关键决策：

- **传输用 SSE 不用 WebSocket**：宿主已是纯 HTTP 单端口形态（无 WS 基建），SSE 走既有 connect 中间件链即可过 cookie 门禁；下行指令也走同一 SSE 流（`event: command`），上行结果用普通 POST 回传——比引 WS 依赖少一层新面。
- **配对模型=登录即身份（v2.1 修订）**：手机用 owner 账号密码登录（P1-3 既有体系）后，phone-agent 前端半边发起 SSE 注册，服务端凭**会话 cookie**识别为 owner 设备并登记入设备表——不搞独立配对码。首次连接时手机端出一行确认「允许这台电脑的 AI 访问本手机」（默认拒绝，用户点允才登记；防误装）。**未登录/未确认=手机只是普通客户端；确认后=可被 AI 调用的端点**。这是安全边界：AI 永远调不到陌生设备。
- **离线语义**：设备表记 `online`/`lastSeen`（心跳超 45s 判离线）。AI 调 `cap.tool.phone` 时宿主先查设备在线——离线返回结构化错误「设备不在线（最后在线 3 分钟前）」，AI 可据此改口，而不是等 30s 超时。

### 9.3 `cap.tool.phone` 工具面（describe 协议，进 agent-loop 既有聚合）

| 动作 | 说明 | Android PWA | iOS PWA |
|---|---|---|---|
| `status` | 设备列表：id/名称/online/lastSeen/能力清单/电量（如可） | ✅ | ✅ |
| `clipboard.read` | 读手机剪贴板 | ✅ | ✅（需用户点授权，WebKit 限制） |
| `clipboard.write` | 写手机剪贴板 | ✅ | ✅（同上） |
| `clipboard.watch` | 订阅剪贴板变化（推给 AI） | ✅（前台时） | ✗（iOS 无后台） |
| `files.list` / `files.read` | 手机侧共享目录文件浏览/读取（File System Access API / OPFS 导入区） | ✅ | 部分 |
| `files.push` | 从电脑推文件到手机（走 Downstream/下载） | ✅ | ✅ |
| `page.snap` | 读取手机当前浏览页面文本/DOM 摘要（手机端点导航的页面） | ✅ | ✅ |
| `screen.capture` | 手机截屏上传 | ✗（浏览器无 API）→ 参照：Android 真包走 MediaProjection；iOS 无 | ✗（仅共享相册导出曲线，标注「不承诺」） |
| `notify` | 手机本地通知（「AI 有结果了」） | ✅（前台 Notification API） | ✅（同左） |
| `geo.current` | 手机定位（如授权） | ✅（Geolocation API） | ✅ |

如实标注：**PWA 形态拿不到系统级截屏/后台常驻**——能力矩阵里写死，AI 调用时返回「该能力需要安装壳（A2 真包）」的结构化降级，而不是假装能做。这是与「真原生 App」的能力差距清单，逐步用 A2 壳（Capacitor）补。

### 9.4 安全设计（照抄 agent-bash 的成熟模式）

`cap.tool.phone` 是「AI 有了手机的眼睛」，风险等级不低于 bash：

- 会话 cookie 硬门禁 + 设备登记确认（设备表只有 owner 登录且点过「允许访问」的设备）；
- 三档模式（confirm/allowlist/yolo，落 `<dataDir>/phone-gateway.json`，服务端裁决）：confirm 模式下 AI 调 `clipboard.read`，**手机上弹审批卡**（复用交互卡审批 UI 先例），120s 不批自动拒——「AI 看手机」必须是用户看得见的；
- denylist：`screen.capture`/`clipboard.watch` 等敏感能力可整体禁用（公网部署建议关）；
- 全量审计：`<dataDir>/phone-audit.log`（谁/AI 调了什么能力/结果摘要/耗时）；
- 结果体积上限（64KB 头尾保留，同 agent-bash），防大文件把上下文打爆。

### 9.5 实施拆分（新插件 `phone-agent`，双入口）

- **前端半边** `plugins/phone-agent/index.ts`：SSE 客户端 + 心跳 + 能力执行器（clipboard/files/notify…）+ 首次连接确认 UI（§9.2「允许访问」一行确认）+ 离线重连。
- **server 半边** `plugins/phone-agent/server.mjs`：`GET /api/phone/events`（SSE）+ `POST /api/phone/command-result` + 设备注册表；宿主零改动（server-registry 登记）。
- **宿主侧门面** `cap.tool.phone`：describe/exec 挂进既有 bus——agent-loop 聚合自动发现，**宿主与 agent-loop 零改动**（这是 describe 协议设计的红利兑现）。
- **phone 前提**：手机处于连接档（能连宿主）。独立档 B 只有在与宿主「相遇」后临时挂上端点（§10.4）。

---

## 10. P4：手机独立档 B——无电脑时的完整 App（v2 新增，R7）

### 10.1 独立档的能力边界（先说清楚「独立」意味着什么）

| 能力 | 连接档 A1 | 独立档 B |
|---|---|---|
| 聊天（多轮/流式/推理思考块） | 宿主 relay | **本地直连云供应商**（§10.3） |
| 会话存储 | 服务端 chat-store | 本地 OPFS（chat-lite 原生路径，天然兜底） |
| 供应商密钥 | 宿主持有 | **手机本地持有一份**（用户在手机上单独配置；仅独立档可见） |
| AI 工具（bash/files/browser…） | 全部（宿主机执行） | 仅手机侧工具（§9.3 中与宿主无关的：剪贴板/文件/通知） |
| 多设备会话同步 | 天然 | 相遇宿主时上收/对账（§10.4） |
| 鉴权 | cookie 会话 | 本地凭据（可无登录，设备即 owner；曾登录过则复用 owner 身份） |

**定案：B 档不追求「小号宿主」，追求「独立可用的聊天 App + 手机传感器」**。bash/browser 等宿主工具在 B 档明确不可用（UI 上灰掉并提示「连接电脑后可用」），不假装。

### 10.2 运行模式开关（宿主壳层，非插件）

启动时判定（可在设置里手动切）：探测上次配置的宿主地址 → 可达=连接档；不可达/未配置=独立档；独立档运行中探测到宿主恢复 → 顶栏出「发现你的电脑 → 连接」提示（不自动切，防意外）。

### 10.3 独立档的模型直连（关键技术风险，先行验证）

B 档要直连 `https://api.mosi.cn/v1` 这类 OpenAI 兼容端点，**CORS 是第一风险**（历史实证：浏览器直连 Moonshot 被 CORS 拦，OPTIONS 404，当时的解法就是建中继）。缓解路线：

1. **首选：供应商本身放行 CORS**（OpenAI 等多数开放端点带 `Access-Control-Allow-Origin: *`）——逐端点实测后维护一张「可直连供应商」清单，UI 里标注；
2. 拦的端点：B 档直接标「需连接电脑使用」，不绕；
3. 若绕不开（主力供应商全拦）：退化为「B 档仅支持直连清单内供应商」，或引入用户自建 relay 的配置项（文档给 frp 一句话方案）。

**不做的**：在手机上跑中继/在独立档塞一个「迷你宿主」——那会把宿主复杂度搬进手机，违背 §1。

### 10.4 相遇升级与数据对账

B 档会话存 OPFS；连上宿主后：a) 独立档会话可选上收（走 chat-store 既有 PUT 通道，baseVersion 409 兜底，UI 提示冲突）；b) 设备登记状态自动恢复，`cap.tool.phone` 端点重新上线（宿主视角=设备从 offline 转 online）。

### 10.5 实施拆分（v2.2：纯插件路线，P4 模式判定从壳层改判进插件）

- 运行模式判定/切换（§10.2）→ **standalone-mode 插件**（非宿主壳层；纯插件可行性见 §11）：setup 里探测宿主可达性，emit `mode-changed` 事件广播，提供 `cap.mode` 查询；顶栏 UI 挂 panel 槽；
- OPFS 会话读写 → chat-lite store.ts 数据源已有多设备 spec 的本地缓存设计，B 档是它的「无服务端」退化态；
- 供应商直连 → real-engine 增加可选 `direct` 模式（不经 `/api/model-relay`，前端直 fetch 供应商；密钥从本地安全区取）；
- 「连接电脑后可用」灰态 → 工具卡 UI 一处判断（agent-loop 不可用时的降级渲染，只读聊天）。

---

## 11. 纯插件实现评估（v2.2 新增：用户问「能不能纯插件方案实现」）

结论先行：**能，95% 以上可纯插件实现**。逐项对照现有契约审计（证据：`src/core/types.ts` 的 SlotHostApi/slots、`plugins/server-registry.mjs` 的 server 半边注入、agent-bash/chat-store 既有先例）：

| 交付物 | 纯插件可行性 | 实现形态 |
|---|---|---|
| P0 PWA 壳（manifest/icon/SW 文件） | ⚠️ 非插件，但**非业务** | `public/` 静态资产 + `index.html` 链接，属宿主壳层「平台能力」——与「核心零业务」不冲突（对标 server/ 的 auth/静态服务也是宿主平台能力）。SW 注册一行代码可由任意插件 setup 里调 `navigator.serviceWorker.register` |
| P0 安装引导气泡 | ✅ 完全插件 | `beforeinstallprompt` 捕获 + 气泡 UI → panel/sidebar 槽组件（iOS 指引条同理） |
| P1 修改服务器地址入口 | ✅ 完全插件 | 设置面板（panel 槽）出地址字段，提交即 `location.assign`——浏览器 API，插件可全权调用 |
| P1 登录 | ✅ 已经是插件 | mock-auth（auth 槽 + cap.auth）现状即如此，手机版登录视图随移动适配已就绪 |
| P1 可达性提示 | ✅ 完全插件 | 插件轮询/失败回调 + 顶栏组件（panel/sidebar 槽），不达时提示+改地址入口 |
| P3 `cap.tool.phone` 全部 | ✅ 完全插件 | §9.5 本来就是 phone-agent 双入口设计：describe/exec 挂 bus（SlotHostApi.registerCapability 现成）、SSE 走 server 半边（server-registry 现成）、agent-loop 聚合零改动 |
| P4 运行模式开关 | ✅ 完全插件 | 新插件 `standalone-mode`：setup 里探测宿主可达性 → emit `mode-changed` 事件（既有事件总线）→ 提供 `cap.mode` 查询；顶栏 UI 挂 panel 槽 |
| P4 本地会话/直连引擎 | ✅ 完全插件（**关键论据**） | chat-lite 本身就是插件（store 数据源切换是插件内部事务）；real-engine 也是插件（加 direct 模式=插件内部改动）；「手机上用哪个引擎/哪个存储」经 registry 启停即达（mock/real 引擎可替换性 2026-11-18 已实测） |
| P4 「连接电脑后可用」灰态 | ✅ 完全插件 | 工具卡渲染在插件内，监听 mode-changed 降级 |

**为什么可行——架构红利兑现**：lite 的四槽 + cap 总线 + 双入口设计里，**手机 App 需要的所有「业务」早就全是插件了**（聊天 chat-lite、引擎 real-engine、登录 mock-auth、会话存储 chat-store）。手机化改造是「既有插件换数据源/换引擎」+「新增三个插件」（install-guide、phone-agent、standalone-mode），不触碰总线、槽位、鉴权任何契约。

**宿主残留（如实列出，共两项且均非业务）**：
1. P0 的静态资产（manifest/icons/sw.js + index.html 三行链接）——平台壳资产，等价于 favicon；
2. 无。`src/core/` 的 TS 代码**预期零改动**（P4 模式判定原计划放壳层，v2.2 改判：进 standalone-mode 插件，壳层更干净）。

**代价与边界（纯插件 vs 壳层做）**：
- 插件间协作靠事件 + cap（`mode-changed` 广播、`cap.mode` 查询），多一层间接——但 lite 本来就是这个范式（model-config-changed 先例），不新增架构债；
- 启动早期（插件 setup 前）的可达性判定有毫秒级窗口差异——模式探测放插件 setup 内即可，无用户可感知差异；
- 唯一做不到纯插件的：**换 origin 之后的首次加载**（P1 首启在浏览器输地址）——那是浏览器行为，任何实现形态都一样。

**定案**：按纯插件路线实施。新增插件清单：`install-guide`（P0）、`standalone-mode`（P4）、`phone-agent`（P3，§9.5 原设计不变）；既有插件内部演进：chat-lite（数据源切换）、real-engine（direct 模式）。宿主只落 P0 静态资产。

## 12. 交付物清单（v2.2 汇总）

| 交付物 | 阶段 | 形态 |
|---|---|---|
| PWA 壳基建（manifest/icon/SW） | P0 | **宿主静态资产**（非业务，仅此项碰宿主） |
| 安装引导气泡 | P0 | install-guide 插件 |
| 修改服务器地址入口 + 可达性提示 | P1 | 插件面板 |
| 登录（账号密码） | P1 | mock-auth 既有插件，零改动 |
| 部署文档 | P1 | docs |
| 手机端点与 `cap.tool.phone` | P3 | phone-agent 插件（双入口） |
| 独立档 B（模式开关/本地会话/直连/相遇升级） | P4 | standalone-mode 插件 + chat-lite/real-engine 插件内部演进 |
| 本方案文档 | — | `docs/mobile-app-plan.md`（v2.2） |
