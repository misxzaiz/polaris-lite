# AI 引擎适配契约(ai-engine) 草案 v0.1

,未实施。与 plugin-contract.md / server-gateway-contract.md 并列。

## 0. 可行性检查结论

基于现有代码核对,方案可行,无需推翻现有设计:

- relay-core 是配置型代理,上游请求头固定,引擎适配不能塞进 relay;引擎插件 server 半边需自行发起上游调用。
- 插件 server 半边现有 createServerPart({dataDir,getSession,store,policy,logger}) 注入,能力按 server-gateway-contract.md 注册到 /api/cap。
- chat-lite 已有工具卡/审批/中断/思考展示 UI,契约事件只需覆盖这些既有能力,无需新增 UI 概念。
- chat-lite 现仅耦合 cap.ai.chat 能力名,演进为面向 ai-engine 契约编程。
- 宿主零业务原则不变:宿主不认识任何具体厂商,引擎差异全部由引擎插件适配。

---

## 1. 目标与非目标

### 1.1 目标
1. 引擎即插件: 新增引擎 = 新增插件,宿主与 chat-lite 零改动。
2. 最大引擎自由度: 思考等级/工具适配/采样参数/私有能力由引擎插件自行映射,契约只约定最小公共面。
3. 统一流事件协议: 文本增量/工具调用/思考/用量/错误/完成走同一种事件流。
4. 同端口统一鉴权: 上游调用在插件 server 半边,密钥不出后端,对外仅宿主一个端口。
5. 面向 Agent 引擎预留: Claude Code 类 CLI Agent 的会话/工具执行/权限确认仅做协议预留。

### 1.2 非目标(v1 不做)
- 不实现具体引擎插件。
- 不定义进程级沙箱(沿用 server-gateway G5)。
- 不规定引擎插件内部架构(可直连/可走 relay/可包 CLI 子进程)。
- 不承诺负载均衡/故障转移/配额管理。

---

## 2. 角色与总览

- 对话 UI 插件(如 chat-lite): 面向 AiEnginePlugin 契约编程,不 import 任何具体引擎。
- 引擎插件: 提供 ai-engine 能力,自行适配厂商差异(思考等级/工具/参数/流格式/CLI 子进程)。
- 宿主: 仅提供能力网关(/api/cap)、权限裁决、审计;不解析任何厂商语义。
- 引擎分派器(平台小模块): 按 engineId 路由到已注册引擎插件,默认 real-engine 兜底。

请求路径: chat-lite -,...) - srv.ai.* - server 半边 -  ---  ##
3.
引擎插件
Manifest
约定  引擎插件在
manifest
中声明:  
provides:
[ai-engine], 
aiEngine:

kind:
chat | agent, 
displayName:
Claude Code, 
models:
[ 

id:
claude-code,
label:
Claude Code,
supportsTools:
true,
supportsStream:
true,
supportsThinking:
true,
contextWindow:
200000
} 
] 
}  约束: -
aiEngine.models
是静态声明;运行时可用
srv.ai.models
返回更全目录,二者冲突时以运行时为准。 -
kind=agent
的引擎必须实现会话事件流(见第
5
节
toolCall/session
事件),否则不得声明为
agent。 -
models
的能力字段仅供
UI
提示与能力协商,宿主不校验语义。 
