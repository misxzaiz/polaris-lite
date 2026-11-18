# polaris-lite 模型能力配置升级分析（仅分析，不实施）

> 日期：2026-11-18。主题：model-admin 插件支持设置**输入/输出 token、图片识别、思考等级**等模型能力，最好**自动识别**。
> 参照系：[polaris-model-capability-inventory.md](polaris-model-capability-inventory.md)（盘点 agent 产出）。

## 1. 现状（lite 侧，事实）

### ProviderConfig（plugins/model-admin/index.ts:19-28）当前只有：
```ts
{ id, name, baseURL, apiKey, models: string[], activeModel, enabled, isDefault }
```
- `models: string[]` 是**纯字符串数组**——每个模型除了名字以外没有任何能力元数据。
- 表单里模型只能手填（逗号分隔文本框），没有任何目录/查询/自动识别。

### real-engine 发送体（plugins/real-engine/index.ts:85-89）当前只有：
```ts
{ model, stream: true, messages }
```
- 不传 `max_tokens`、不传 `reasoning_effort`/`thinking`、不传任何能力标志。
- 图片内容目前根本没有发送通道（附件功能本身在 lite 还未实施，属输入框改造第 2 期范围）。

### 现有可用通道
- 配置存储：`cap.config` namespace `model-admin`（config-manager 插件），改 ProviderConfig 结构**不需要动宿主**——加字段即可，旧数据读出时字段缺省。
- 引擎消费：real-engine 从同一命名空间读 providers，发送体由它拼装——加字段同样**只改插件**。

## 2. 目标能力矩阵（用户需求展开）

| 维度 | 用户原话/引申 | 具体字段 | 消费点 |
|---|---|---|---|
| 输入 token | "设置输入token" | `maxInputTokens`（context window） | 超限截断/提醒；后续 ContextMeter 用量条 |
| 输出 token | "设置输出token" | `maxOutputTokens` | 请求体 `max_tokens` |
| 思考等级 | "思考等级" | `effort: 'minimal'|'low'|'medium'|'high'` | 请求体 `reasoning_effort`（OpenAI 风格）/ `thinking`（Anthropic 风格），按供应商方言切换 |
| 图片识别 | "是否支持识别图片" | `vision: boolean` | 附件含图片时：支持→发 base64 图片消息；不支持→拦截+提示（Polaris 的降级行为参照 inventory） |
| 自动识别 | "最好支持自动识别" | 见 §4 三级探测 | 免手填：models 列表 + 能力字段尽量自动填充 |

## 3. 数据结构提案（ProviderConfig 演进，只改 model-admin + real-engine）

```ts
interface ModelCapabilities {
  /** 输入上下文窗口（token）。0/缺省=未知 */
  maxInputTokens: number;
  /** 单次回复上限。0/缺省=用引擎默认 */
  maxOutputTokens: number;
  /** 思考等级：null=该模型不支持；缺省 undefined=未知（探测后回填） */
  effort: 'minimal' | 'low' | 'medium' | 'high' | null;
  /** 是否支持图片输入。缺省=未知 */
  vision: boolean;
  /** 能力来源标记（自动识别结果的可信度追溯） */
  detected?: 'builtin' | 'probe' | 'manual';  // 手填最高优先级
}

interface ProviderConfig {
  // ...现有字段不动（id/name/baseURL/apiKey/enabled/isDefault）
  models: ModelInfo[];              // string[] → 结构化（旧字符串数据迁移：见 §6.3）
  activeModel: string;
}

interface ModelInfo {
  id: string;                       // 原 strings 里的模型名
  capabilities: ModelCapabilities;
}
```

兼容性要点：
- cap.config 旧数据里 `models` 是 `string[]`。model-admin 读取时做归一化（`string → {id, capabilities:{}}`），写回时总是新结构——**不需要数据迁移脚本**，读路径归一即可（符合用户「不需要兼容旧版本」的一贯偏好，但归一化是零成本的防御）。
- UI 表单：模型列表从「逗号分隔文本框」改为「模型条目列表」，每条展开能力编辑区（手填=manual，覆盖一切自动值）。

## 4. 自动识别设计（核心亮点，三级探测瀑布）

**优先级：manual > probe > builtin 推断 > 未知**。任何一级得到值就不再向下覆盖。

### L1 · 目录查询（models 列表本身）
多数 OpenAI 兼容端点有 `GET {baseURL}/models`：
- 面板已有「测试连通」按钮走 `/api/model-relay`——同一通道加 `action: 'list-models'`：宿主中继转发 `{baseURL}/models`，返回 id 数组填入 models。
- 这是纯 model-admin 插件 + 中继既有白名单能力，**宿主零改动**（relay 的 url 字段本来就允许任意白名单域名的任意 path）。
- 常见问题：MOSI 等 OpenAI 兼容端点该接口通常免 key 或同 key 可用；失败则保持手填。

### L2 · 能力探测（对选中模型 probe 一次）
设计为**面板上的「自动识别」按钮**（用户触发，非静默——静默会产生计费调用，不可接受）：
- **vision**：发一条 1×1 像素 base64 图片消息 + `max_tokens: 1`。成功(2xx)→vision=true；明确报错（含 "image"/"not support"/"multimodal" 等 pattern）→false；网络错→unknown。
- **maxOutputTokens**：先发 `max_tokens: 16` 的 "hi"，若被拒且错误信息含 "max_tokens"/"too large" 等→用二分法粗探上限（最多 3 次）；或从 200 响应的成功先例直接采纳配置值。
- **effort**：发 `reasoning_effort: 'low'` 试探：2xx 且响应头/体内有 reasoning 字段→支持；400 且错误指向参数→null。
- **maxInputTokens**：无法可靠探测（真探测需灌超长 prompt 烧钱）——**不从 probe 来**，走 L3。
- 成本控制：全流程 ≤5 次调用、每次 max_tokens≤16、1×1 图片；面板明示「将产生少量计费调用」。
- 结果写回 `capabilities` 并标 `detected:'probe'`；用户手改任何字段后该字段变 manual。

### L3 · 内置推断表（零成本兜底）
按模型 id 的 pattern 匹配一张小内置表（model-admin 插件内静态数据）：
```
gpt-4o*        → vision:true,  effort:null(支持但字段名不同), 128k
gpt-4.1*       → vision:true,  effort:null, 1M
o3*/o4*        → vision:true,  effort:支持, 200k
claude-*       → vision:true,  effort:支持(thinking), 200k
deepseek-chat  → vision:false, effort:null, 64k
nex-* / qwen* / glm* / kimi* → 有已知值填，否则 unknown
```
- 表只是初值，probe 与 manual 可覆盖。表数据放 model-admin 插件内（可随版本更新），**不进宿主**。
- MOSI 的 `nex-n2.6` 若不在表内→unknown，由 L2 probe 定（这就是"自动识别"对该供应商的实际路径）。

### L2.5 · 响应回流（被动识别，零成本增量）
real-engine 每次真实对话已经拿到响应：`usage` 里常带 token 数、响应里可见 reasoning 痕迹——**顺手回写**：
- 若某模型真实调用曾成功带 `reasoning_effort` 参数→effort=支持；
- 若曾成功发送图片消息→vision=true。
- 回写走 model-admin 已有 `model-config-changed` 事件反向通道（或直接 cap.config setAll）——**仍然只改两个插件**。
- 被动回流让"用着用着就准了"，与按钮主动探测互补。

## 5. 运行时消费（real-engine 发送体演进）

```ts
body: {
  model, stream: true, messages,
  ...(caps.maxOutputTokens ? { max_tokens: caps.maxOutputTokens } : {}),
  ...(caps.effort ? { reasoning_effort: caps.effort } : {}),   // OpenAI 系
  // Anthropic 系在同字段位换 thinking: {type:'enabled', budget_tokens} ——按 baseURL 方言分派
}
```
- 方言分派规则放 real-engine（一张 baseURL→dialect 小表：api.anthropic.com→anthropic，其余→openai-compatible）。
- vision 消费点在未来的附件链（输入框改造第 2 期）：`!vision && 有图片附件` → 面板/输入区拦截提示（对齐 Polaris 的降级行为，具体形态等 Polaris 盘点报告）。
- maxInputTokens 第一版只做「UI 展示 + 超 context 提醒」，不做自动截断（截断语义复杂：截历史还是截系统词，先不做，防误杀）。

## 6. 实施判定与阶段路线

**归属结论：全部只改 model-admin + real-engine 两个插件，宿主零改动。**
（探测请求经既有 /api/model-relay 转发；配置存既有 cap.config；事件用既有广播——不需要任何新 cap。）

### 阶段 1：结构化模型条目 + 手填能力（model-admin）
ProviderConfig.models 结构化；表单改模型条目列表+能力编辑；real-engine 消费 maxOutputTokens/effort 进发送体。验收：手填 max_tokens/effort 后，抓包确认请求体带上；effort 对 MOSI 生效（ nex 系对 reasoning_effort 的真实反应以实测为准，报错则置 null）。

### 阶段 2：目录查询 + 内置推断表
「拉取模型列表」按钮（GET /models 经中继）+ L3 pattern 表自动填初值。验收：MOSI 一键拉出 nex-n2.6 等列表，内置表对常见模型给出 vision/token 初值。

### 阶段 3：能力探测按钮 + 被动回流
「自动识别」按钮（L2 探测瀑布）+ real-engine 响应回流（L2.5）。验收：对未知模型点按钮后 vision/effort/maxOutputTokens 被正确回填并标记 detected:probe。

### 与输入框改造的关系
- 本主题的阶段 1 与输入框第 4 期（模型选择 popover）共用 ProviderConfig 新结构——**建议本主题先行**，popover 直接消费结构化能力（能显示 vision 标志、effort 快切）。
- 图片识别（vision）的消费端在输入框第 2 期（附件）落地时自然接上。

## 7. 风险与边界

1. **探测的计费与限速**：L2 必须用户显式触发 + 成本封顶声明；探测失败不得阻塞手填。
2. **方言覆盖不全**：reasoning 参数各家命名不一（reasoning_effort/thinking/enable_thinking），第一版只支持 OpenAI 系 + Anthropic 系两种，其他 baseURL 默认不传——宁可少传不可错传（错传=400 直接断流）。
3. **内置表腐化**：模型迭代快，pattern 表必须标 `detected:'builtin'` 让 probe/manual 可覆盖；表更新走插件版本。
4. **maxInputTokens 探测不可行**：明确不烧钱探测，只允许 L3/手填；UI 上「未知」就显示未知，不编数。
5. **GET /models 各家兼容性**：部分端点 401/404/字段名不同（data vs models）——解析做多形态容错，失败降级手填。
