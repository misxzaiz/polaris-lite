# Agent Loop + Bash 工具实施定案（agent-loop-plan）

> **历史文档**：前端 agent-loop 插件已于 2026-11-26 后端编排化时整块删除——
> 编排循环现由服务端 agent-runner 插件执行（spec 落地见
> docs/agent-runner-implementation.md）。本文保留作设计依据与术语出处。

> 前置分析：docs/agent-loop-analysis.md（上游 function calling 已实探可用）。
> 本文档为**复审后的实施方案定案**，2026-11-19 起实施。

## 0. 复审新增实证

| 项 | 结论 |
|---|---|
| 流式 tool_calls | ✅ 实测：MOSI 流式下发 `delta.tool_calls`（本次观测为**单分片完整下发** id/name/arguments）+ `finish_reason:'tool_calls'`；仍按 OpenAI 规范做 index 分片聚合以防其它上游分片 |
| 引擎已被并行重构 | real-engine v0.3.0：密钥已下沉服务端（providerId 制）、`requires` 拓扑排序已落地、事件通道已改为 `<cap>:event` 且 source=宿主注入提供方 id（不可伪造） |
| 鉴权已升级 scrypt | owner 记录 {algo:'scrypt',...}，透明升级；审计冒烟需按新格式注入临时凭据 |
| grants 强制登记 | build-plugins fail-fast：manifest 申请 ⊆ grants 授权，未登记直接构建失败 |

## 1. 宿主改动面（最小化定案）

**原则：一切业务能力在插件。唯一无法插件化的是「进程执行」——浏览器沙箱物理边界。**

| 改动 | 性质 | 说明 |
|---|---|---|
| `server/tool-exec.mjs`（新，自包含 ~200 行） | 宿主**平台基础设施**（与 relay/auth 同层：cookie 门禁 + 系统资源访问） | 唯一新增服务端文件 |
| `server/host.mjs` +2 行 | 装配 | import + middlewares.push |
| `src/core/`、`server/` 其余、`vite.config.ts` | **零改动** | |
| `public/grants.json`、`public/plugins/registry.json`、`plugins/build-plugins.mjs` | 配置/构建脚本（非宿主运行时） | 新插件登记，build 脚本本身强制要求 |

插件侧：real-engine（工具透传）、chat-lite（工具卡片+审批 UI）、agent-bash（新）、agent-loop（新）——全部插件实现。

## 2. 契约定案

### 2.1 事件通道（沿用 `<cap>:event` + 宿主注入 source）
- loop 注册流式 cap `cap.agent.loop`：其 emit 由宿主镜像到 `cap.agent.loop:event`（source='agent-loop'）；
- chat-lite 同时订阅 `cap.ai.chat:event`（普通模式）与 `cap.agent.loop:event`（loop 模式），messageId 精确过滤防串台；
- loop 内部经 `api.listen('cap.ai.chat:event')` 收引擎事件（内部轮次 messageId=`${assistantId}::t${n}`，chat-lite 不会误匹配），把可见 delta 转发为 assistantId。

### 2.2 事件种类（loop → chat-lite）
```
message.delta / message.done{finishReason?,interrupted?} / stream.error   （兼容现有）
tool.card              {sessionId, messageId, callId, name, command, args}    建卡(running)
tool.result            {sessionId, messageId, callId, status:'done'|'error'|'denied', stdout?, stderr?, exitCode?, durationMs?, truncated?}
tool.approval.required {sessionId, messageId, callId, name, command}
tool.approval.resolved {sessionId, messageId, callId, decision:'once'|'always'|'deny'}
loop.done              {sessionId, messageId, turns}
```

### 2.3 cap.agent.loop 动作（单 cap 多 action；流式 cap 的所有 action 都路由到 handler）
- `start` {sessionId, messageId, prompt, history, attachments?}
- `interrupt` {sessionId} → 内部杀引擎流 + abort 在途 exec + 审批挂起按 deny 收敛 → found 回执
- `resolveApproval` {sessionId, callId, decision}

### 2.4 工具插件契约（agent-bash）
- provides: `cap.tool.bash`；handler action：`describe` → ToolDescriptor{name:'bash', description, parameters:{command, timeoutMs?}, danger:'execute'}；`exec` {command, timeoutMs?} → fetch `/api/tool/exec`（cookie 自动携带）→ {stdout, stderr, exitCode, durationMs, truncated}
- setup 时 emit `tool-registered`；loop 启动时**主动拉取**（requires 拓扑保证 bash 先装配，拉取防事件时序竞态）+ 监听 tool-registered 双保险

### 2.5 服务端 /api/tool/exec + /api/tool/config
- **cookie 硬门禁**（auth.getSession）；`PLITE_TOOL_EXEC=0` 一键整体禁用；
- 配置落盘 `.polaris-lite/tool-exec.json`：{enabled, mode:'confirm'|'allowlist'|'yolo', allowPrefixes[]}，默认 mode='confirm'；服务端为裁决者（不信任前端）；
- denylist 硬拦截（不可被 yolo 豁免）：`curl|sh`/`rm -rf /`/`format`/`mkfs`/`shutdown`/`reg add`/`schtasks`/写 `.polaris-lite/`（providers.json/auth-owner.json 保护）等正则；
- spawn shell（win32 `cmd /c`，类 Unix `/bin/sh -c`）、cwd 锁定 `<dataDir>/workspace`、timeout 默认 30s 上限 300s、输出 64KB 头尾保留+truncated、并发 1（BUSY 拒绝）、win32 杀树 `taskkill /T /F`、客户端断开（loop 中断）→ abort → 杀树；
- 全量审计行落 `tool-exec-audit.log`（命令、退出码、耗时、mode、会话）。

### 2.6 chat-lite 工具卡片（参考 Polaris ToolCallBlock/PermissionRequestRenderer 收敛版）
- 两卡分工：工具卡（折叠头：左 2px 分类色条 + 字母块 `B` + 工具名 + 命令摘要 + 状态图标 + 耗时；展开体：命令 pre、输出 pre `max-height:12rem` 滚动、退出码）+ 审批卡（warning 色边 + 三按钮：允许一次/总是允许该前缀/拒绝；resolved 后收敛为一行回执）；
- store 零宿主依赖：本地 `ToolCardMessage`（role 'tool'），append 时窄化 cast，history 映射排除 tool 卡；
- 「发新消息即过期」语义沿用 Polaris：pending 审批在新 start 时自动 resolved=deny。

## 3. 状态机与上限

```
IDLE → RUNNING(轮n: cap.ai.chat, messages=shadow) 
  finish stop → DONE；finish tool_calls → 审批→exec→shadow+tool结果→下一轮
上限 maxTurns=8 / maxToolCalls=16 / 审批超时 120s=deny / 结果喂回截断 8KB
中断：chat-lite 停止 → cap.agent.loop/interrupt（found=false 时回落 cap.ai.chat.interrupt）
shadow transcript：Map<sessionId, messages[]>（内存）；刷新丢失后由 history 可见消息重新播种（tool 卡不计入）
无工具注册时：loop 直通模式（透传 start 给 cap.ai.chat，不监听不转发——引擎事件直接到 chat-lite）
```

## 4. 分期验收

| 期 | 交付 | 验收 |
|---|---|---|
| A | real-engine tools 透传+聚合 | 流式探针出 tool.calls 事件 |
| B | server exec 通道 | 无 cookie 401 / echo 通 / timeout 杀 / denylist 拒 / config 读写 |
| C | agent-bash + agent-loop | yolo 模式「列出工作区文件」→ 卡片 + 最终回答引用真实输出 |
| D | chat-lite 工具卡 + 审批 | confirm 模式三按钮闭环；中断收敛；tsc+build+E2E |
