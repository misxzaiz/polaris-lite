# 服务端能力网关契约（Server Capability Gateway）

> 状态：v1 设计稿（待实施）。把前端 CapBus 的 gate->审计->转发 模型延伸到服务端，是插件商城化（外部插件安装/更新/受控运行）的地基。与 docs/plugin-contract.md 并列：那份约束「插件能贡献什么 UI/能力」，这份约束「插件的服务端能力如何被暴露、鉴权、转发与审计」。
> 背景问题：当前插件 server 半边以 connect 中间件形式同级直挂宿主 HTTP 端口（server/host.mjs：[auth, providers, relay, ...pluginMiddlewares]）。单端口目标已满足，但「宿主统一转发 + 统一鉴权」未成立：每个插件自行解析 URL、自行调用 getSession、自行实现安全逻辑。对内置插件可行；对商城里的不可信插件，任何一处遗漏都是洞。

---

## 一、目标与非目标

### 目标

1. 单端口：所有领域请求仍只经宿主一个对外端口（现状保持）。
2. 统一转发：领域请求统一进入一个网关入口，由宿主识别能力、定位提供方插件、转发执行。
3. 统一鉴权：认证（会话）与授权（grants）都在网关裁决，插件 handler 拿到请求时权限已通过。
4. 统一审计：每次领域调用在网关层落一条审计（谁、调了什么、何时、结果）。
5. 参数化权限：授权从「能力名级」（cap.tool.fs）细化到「能力 + 动作 + 限制」级。
6. 商城可演进：网关裁决点固定后，第三方插件 server 半边未来可平移到 worker/子进程隔离，只换传输层，权限模型不变。

### 非目标（v1 不做）

- 不做第三方插件进程级沙箱（v1 仍是宿主进程内 handler；隔离是 v2 议题）。
- 不改动平台端点：/api/auth/*、/api/providers/*、/api/model-relay 保持专用中间件（它们是 P4 划给核心的平台能力：鉴权、供应商配置、密钥中继、SSRF 策略）。
- 不引入新网络端口、不引入反向代理依赖。

---

## 二、总览

浏览器插件（UI 半边）以 fetch(/api/cap, {target, action, payload}) 发起领域调用；宿主服务端（唯一端口）内：

1. 平台层：auth 会话门禁 -> providers API -> model-relay -> 静态资源；
2. /api/cap 能力网关：认证(getSession, 未登录 401) -> 路由(capabilityTable.get(target) 定位提供方插件与 handler) -> 授权(resolvePolicy + serverRules) -> 审计(落一行：调用方/目标/动作/结果/耗时) -> 转发 handler；
3. 插件 server 半边：注册 capability handler，不再自挂路由。

关键转变：插件 server 半边从「我要一个 URL 前缀」改为「我提供若干能力」。URL 空间收归宿主；插件只拥有能力名。

---

## 三、统一请求协议（/api/cap）

### 3.1 请求

POST /api/cap
Content-Type: application/json
Cookie: <宿主会话 cookie>

interface CapHttpRequest {
  target: string;    // 能力 id，如 srv.fs.list、srv.tool.exec（命名见第四节）
  action?: string;   // 动作名，缺省 call；同一能力下的子操作
  payload?: unknown; // 任意 JSON；handler 自行解释
  stream?: boolean;  // true = SSE 流式响应（见 3.4）
}

### 3.2 响应（非流式）

HTTP 200，业务结果在信封内（与前端 CapResponse 同构，故意保持一致）：

interface CapHttpResponse {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

错误码约定（网关层，先于插件 handler）：

| code | HTTP | 含义 |
|---|---|---|
| UNAUTHENTICATED | 401 | 无会话 / 会话过期 |
| UNKNOWN_CAP | 404 | target 未注册（或提供方插件被禁用） |
| CAP_NOT_PROVIDED | 404 | 提供方存在但该 target 不在其注册表 |
| PERMISSION_DENIED | 403 | grants 未授权该能力/动作，或违反 limits |
| PAYLOAD_TOO_LARGE | 413 | 请求体超限 |
| HANDLER_ERROR | 500 | 插件 handler 抛错（message 透传，堆栈不透出） |

网关错误一律走统一信封，插件 handler 不得自行 writeHead 改写状态语义（handler 只返回 { data } 或抛错；流式能力除外）。

### 3.3 调用方身份

网关把调用方上下文注入 handler，插件无法伪造：

interface GatewayContext {
  user: { id: string; name: string; roles: string[] }; // 已验证的登录用户；插件拿不到原始 req/res
  target: string;  // 能力名（已通过授权校验）
  action: string;
  payload: unknown; // 已做 JSON 解析与大小限制
  dataDir: string; // 平台能力，按需注入
  logger: Logger;
  signal: AbortSignal; // 客户端断开时 abort（流式/长任务用）
}

与 v1 中间件契约的本质区别：插件不再接触原始 req/res。它拿不到 headers、拿不到其它路由、拿不到绕过网关写回响应的通道。「能不能读文件、能不能 spawn」由 handler 自己实现，但「这次调用是否被允许」由宿主裁决。

### 3.4 流式能力（SSE）

请求同 3.1，body.stream === true；响应 text/event-stream，逐事件下发：

interface CapStreamEvent {
  kind: string;      // data | progress | error | done
  payload?: unknown;
  seq: number;       // 网关统一编 seq，防止插件伪造顺序
}

复用 relay-core 已验证的机制：X-Accel-Buffering: no、背压（drain）、客户端断开 -> abort handler。handler 形态：

type StreamCapHandler = (ctx: GatewayContext, emit: (ev: { kind: string; payload?: unknown }) => void) => Promise<void>;

---

## 四、能力命名与注册表

### 4.1 命名规则

服务端能力统一前缀 srv.，与前端 cap 命名（cap.ai.chat / cap.tool.fs 等）保持同构：

srv.<domain>.<verb>      // 例：srv.fs.list / srv.fs.read / srv.tool.exec

- srv. 前缀由网关保留，仅服务端能力可注册；前端 cap（cap.*）不得出现在 /api/cap。
- 能力名全局唯一，注册冲突 = 宿主启动失败（fail-fast，与前端 bus.register 一致）。
- 插件在 manifest 里声明 serverCapabilities: [srv.fs.list, ...]（见第六节）。

### 4.2 注册（插件侧）

plugins/<id>/server.mjs —— v2 契约：

export function createServerPart(options) {
  const { dataDir, logger, registerCapability } = options;
  // registerCapability(target, handler | { handler, stream }) 由宿主注入；
  // 宿主在注入前已校验 manifest.serverCapabilities 对 grants provides 双向一致。
  registerCapability(srv.fs.list, async (ctx) => { /* ... */ });
  registerCapability(srv.fs.read, { stream: false, handler: async (ctx) => { /* ... */ } });
}

注册表在宿主内是一个 Map<target, { pluginId, handler, stream }>，由网关独占访问。host.mjs 依旧不 import 任何插件实现——仍经 plugins/server-registry.mjs 装配，现有 server-boundary 测试的守卫逻辑保持有效（只需把「返回中间件」改为「返回注册函数调用」）。

### 4.3 与现有中间件的关系（迁移期）

| 阶段 | 形态 |
|---|---|
| 现状 | 插件 server 半边 = connect 中间件，自挂 /api/fs/*、/api/tool/* |
| 过渡 | 网关上线，新能力一律走 /api/cap；旧端点保留并加 deprecation 告警日志 |
| 完成 | 旧领域端点删除；server/ 目录仅剩平台能力 + 网关 + 静态服务 |

迁移完成的判定沿用「删除即降级」试金石：删掉任一插件 server 半边，宿主照常启动，对应能力返回 UNKNOWN_CAP。

---

## 五、授权与限制（grants v2）

### 5.1 从能力名到动作级规则

现状 grants.json 每插件只有 capabilities/provides/events 三个字符串数组。v2 增加 server 规则：

{
  "version": 4,
  "unlistedPolicy": "declare",          // 商城化后建议默认改 "deny"
  "plugins": {
    "file-browser": {
      "provides": ["cap.tool.fs", "srv.fs.list", "srv.fs.read"],
      "serverRules": {
        "srv.fs.read": { "allow": true, "limits": { "maxBytes": 524288, "mode": "readonly" } },
        "srv.fs.list": { "allow": true, "limits": { "maxEntries": 500 } }
      }
    },
    "agent-bash": {
      "provides": ["cap.tool.bash", "srv.tool.exec"],
      "serverRules": {
        "srv.tool.exec": { "allow": true, "limits": { "timeoutMs": 300000, "concurrency": 1 } }
      }
    }
  }
}

### 5.2 裁决顺序（网关内固定，不可被插件影响）

1. 会话有效？（auth.getSession）
2. target 已注册？（capabilityTable）
3. 提供方插件的 provides 含 target？（manifest 对 grants，双向一致）
4. serverRules[target].allow === true？
5. payload 满足 limits？（网关做通用校验：大小/数量/超时上限；领域细节仍归 handler）
6. 落审计 -> 转发 handler

通用 limits（字节数、条数、超时、并发）由网关强制；领域语义 limits（如「只能读 workspace 根」）v1 仍由 handler 自查（现有 realpath 白名单逻辑保留）。v2 演进方向是把「路径白名单」也上提为声明式 limits（roots: [...]），使网关可对不可信插件做参数级裁决。

### 5.3 未登记插件的兜底

沿用 unlistedPolicy 语义：declare = 按 manifest 放行并告警；deny = 零能力。面向商城分发时，宿主默认应切到 deny，由安装器在用户确认后写入 grants——即「安装即授权」成为显式用户动作，而不是静默信任。

---

## 六、manifest 变更

interface LiteManifest {
  // ...现有字段不变
  serverCapabilities?: string[];   // v2 新增；仅允许 srv.* 前缀；server.mjs 存在时必填
}

- 构建期门禁（build-plugins.mjs）新增校验：serverCapabilities 必须以 srv. 开头、全局唯一、不得与前端 provides 混用；
- grants 构建校验同步：声明了 serverCapabilities 而 grants 未登记 -> 构建告警（沿用现状策略）。

---

## 七、审计

网关统一落审计（替代各插件自写日志文件的做法），落盘 <dataDir>/cap-gateway-audit.log（JSON Lines）：

{ "at": 1763539200000, "pluginId": "agent-bash", "target": "srv.tool.exec", "action": "call", "user": "alice", "ok": true, "durationMs": 812, "code": null }

- 失败（401/403/404/handler error）同样落审计，ok:false + code；
- 载荷不进审计（可能含密钥/敏感内容），只记元数据；
- 保留 cap.meta 类自省不入审计的豁免思路，但 srv.* 无豁免——领域能力全部入审计。

---

## 八、安全分析

| 威胁 | 现状（中间件直挂） | 网关后 |
|---|---|---|
| 插件忘写会话校验 | 端点裸奔 | 网关统一 401，插件接触不到未鉴权请求 |
| 插件响应任意 URL（含宿主路径） | 可能（拿到完整 req） | 不可能（接触不到路由层） |
| 越权调用他人能力 | 靠插件自觉 | 网关按 grants + serverRules 裁决 |
| 超大载荷 / 滥用 | 各自实现 | 网关统一限制 |
| 无审计调用 | 可能 | 全量审计，无旁路 |
| 插件伪造响应头/状态语义 | 可能 | handler 只能返回数据或抛错 |

残余风险（如实记录）：

1. 进程内隔离仍未解决：handler 仍在宿主进程里，恶意插件可直接 require node 内置模块做任何事。网关解决的是「未授权调用」，不解决「授权后的恶意代码」。进程隔离是 v2 必选项（见第九节）。
2. payload 领域语义校验仍在插件：网关只能做通用限制，无法理解「这个路径是否越界」。在声明式 limits（roots 白名单上提）完成前，file-browser 这类能力对第三方插件仍需人工审核。

---

## 九、商城化衔接（本契约的动机）

| 商城需求 | 本契约提供 | 后续契约 |
|---|---|---|
| 插件可独立分发 | 现有 plugin.json + registry（UI 半边已满足） | 插件包格式（含 server 半边 + 签名 + 版本兼容） |
| 安装后可用，不改宿主代码 | 网关注册表取代静态 SERVER_PLUGINS 清单 -> 动态注册 | 安装器 API（落盘 + 注册 + grants 写入） |
| 不可信插件受控运行 | 统一鉴权/审计/限制的裁决点 | worker/子进程隔离 + capability 代理 |
| 更新与回滚 | 能力注册是运行时状态，可重载 | 版本协商（manifest.apiVersion） |

实施顺序建议：

1. G1：/api/cap 网关 + capabilityTable + 审计（宿主侧，先支持内置插件迁移）；
2. G2：file-browser、agent-bash 迁移到 srv.* 能力注册，删除旧领域端点；
3. G3：grants v2（serverRules）+ manifest.serverCapabilities 构建门禁；
4. G4：动态安装 API（商城地基）：受保护端点写入插件目录 + 注册表重载 + grants 变更；
5. G5：第三方插件 worker 隔离（handler 移出宿主进程，网关改走 capability 代理）。

---

## 十、执行层对照（与 plugin-contract.md 同风格）

| 约束 | 执行层 |
|---|---|
| 领域请求只能走 /api/cap，插件不得自挂路由 | 网关实现 + tests/server-boundary（扩展） |
| srv.* 能力名唯一、宿主保留 | capabilityTable 注册冲突 fail-fast + 构建期校验 |
| serverCapabilities 必须 srv. 前缀 | 构建期门禁（build-plugins.mjs） |
| provides 与 grants 双向一致 | resolvePolicy（复用前端逻辑）+ 网关步骤 3 |
| 领域调用全量审计 | 网关步骤 4 + tests/gateway-audit.test.mjs（新增） |
| 未授权能力 fail-closed | 网关步骤 4/5，错误码 PERMISSION_DENIED |
| 插件 handler 不接触 req/res | GatewayContext 设计保证 + 代码评审约定 |

> 变更本契约时同步三处：本文件、网关实现、tests/。以代码门禁为准。
