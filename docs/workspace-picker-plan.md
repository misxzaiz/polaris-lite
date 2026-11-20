# 输入区工作目录选择 · 实施方案（面向用户，仅方案未实施）

> 目标：用户不必理解「工作区/workspace/cwd」，也能一眼确认 **AI 正在哪个文件夹里干活**，并在输入区一次改对；切换只影响当前对话，失败可恢复。
> 前置事实：`WorkspacePicker.tsx`、会话级 `workspaceId` 已存在（`6c6bf53` / `afe3441`），但入口只在会话侧栏；输入区抽屉里的工作区是只读 `span`。

## 一、用户视角的四条原则

1. **先看见，再选择**：操作行始终能看见当前目录名；点击名字直接选，不要求先找到「调谐」。
2. **不打断对话**：选择在输入区抽屉内完成，二级视图切换，不弹全屏浮层、不跳走。
3. **说清影响范围**：切换后明确「仅本对话」；生成中不允许切换，避免误以为当前这一轮已经换目录。
4. **失败不静默**：目录不存在、绑定失效、文件浏览器被禁用，都要给出原因和下一步，而不是悄悄回默认。

## 二、目标交互

### 2.1 收起态（默认）

```
[附件] [调谐] [📁 polaris-lite]                         [发送]
```

- 有显式绑定时，操作行显示文件夹图标 + 当前目录名（点击直接打开选择器）；
- 未绑定时保留现有键盘提示（`Enter 发送`），不额外占位；
- 手机窄屏隐藏键盘提示，只保留目录名；目录名超长省略，`title` 给全路径。

### 2.2 抽屉一级（调谐）

```
工作目录      polaris-lite            可写  ›
执行模式      审批模式              命令需确认
关联只读      1 个 · is-scm-server    只读参考
待发队列      无
```

点「工作目录」进入二级；点「关联只读」进入二级并展开对应分组。

### 2.3 抽屉二级（选择工作目录）

自上而下：

1. **当前目录卡**：名称 + `仅本对话` 角标 + 等宽路径 + 一句说明（可写、历史消息不迁移）；
2. **最近使用**：最多 3 个 chip，一键切回；
3. **已登记目录**：单选列表（名称 + 路径 + 当前标记；失效项显示「目录不存在」且不可选）；
4. **浏览文件夹…**：进入三级，内联浏览；
5. **关联只读目录**：多选，最多 3 个；明确「可读、不可写、命令不在这里执行」；
6. **底部固定**：`新对话默认使用` 开关 + `改为跟随全局默认` 文本按钮。

### 2.4 抽屉三级（浏览文件夹）

- 面包屑 + 仅文件夹列表 + 当前选中高亮；
- 底部主按钮「使用此文件夹」；非已登记目录时提示「将自动登记为工作目录」；
- 服务端仍做白名单/禁区/realPath 校验；UI 不自行拼路径；
- `PLITE_FS_SESSION=0` 或文件浏览器不可用时，隐藏三级入口，保留「输入绝对路径」兜底。

## 三、状态模型

```ts
// chat-lite 会话（已有 workspaceId，新增 linked）
ChatSession {
  workspaceId?: string;          // 主目录 root id；undefined = 跟随全局
  linkedWorkspaceIds?: string[]; // 只读关联 root id，最多 3 个
}

// chat-lite 偏好（新增，独立于 config-manager，避免插件禁用即丢）
chat-lite.workspace-prefs.v1 {
  defaultWorkspaceId?: string;   // 新对话默认绑定；undefined = 跟随全局
  recentWorkspaceIds: string[];  // 最多 5 个，最近在前
}
```

**不变量**

- 主目录只有一个，决定 bash cwd；关联目录只读，不能成为 cwd；
- 主目录自动从关联列表移除，避免同一目录两种语义；
- 绑定存 root id，显示名实时从 `/api/fs/roots` 解析；root 改名不影响绑定；
- root 失效：保留绑定以便恢复，但 UI 必须显示「已失效，当前回退到默认目录」，不能装作正常。

## 四、数据流

```
选择/浏览
  → /api/fs/roots 或 /api/fs/roots/from-path（服务端校验+登记）
  → store.setSessionWorkspace(sessionId, rootId)
  → localStorage 防抖落盘（pagehide flush）
  → 下一次 send 的 cap.agent.loop start payload:
       { workspaceId, linkedWorkspaceIds }
  → agent-loop 解析主根为 exec cwd；关联根写入 system prompt / files 工具可见列表
  → 解析失败：cwd 回落 builtin，并向对话发一条可见提示
```

## 五、现状必须一起修的坑

| 问题 | 处理 |
|---|---|
| `WorkspacePicker` 的遮罩是 `.chat-sessions` 内绝对定位，搬进输入区会被 `overflow:hidden` 裁掉 | 拆成 `WorkspacePickerBody`（纯内容）+ `WorkspacePickerDialog`（侧栏用）；输入区只用 Body |
| 抽屉 `max-height:180px` 装不下选择器 | 一级保持 180px；二级改为 `height:min(56dvh,420px)`，头部/底部固定、中间滚动 |
| `chat-ws-chip` 是 `span`，CSS 有 pointer 但点不动 | 改为 `button`，点击直接进二级 |
| `addAndPick` 用 `path.includes(label)` 猜根，可能误绑 | 直接用服务端返回的 `roots` 按 `path` 精确匹配 |
| `workspace-renamed` 已发出但 chat-lite 未监听、grants 未登记 | 补 manifest/grants/listen，改名后标签即时更新 |
| 失效 root 静默回落 | 当前卡显示警告 +「重新选择」；对话内提示一次 |
| 生成中切换目录语义不明 | 选择器禁用并提示「本轮生成中，结束后可切换」 |
| 偏好依赖 config-manager | 新偏好写 `chat-lite.workspace-prefs.v1`；config-manager 只继续承载 file-browser 的全局 activeRoot |

## 六、实施切分

| 批 | 内容 | 量 |
|---|---|---|
| W1 | 状态：`linkedWorkspaceIds`、偏好（默认/最近）、失效解析、start payload 透传、agent-loop 关联根 prompt | ~90 行 |
| W2 | UI：操作行目录名、抽屉一级/二级、内联浏览、最近/已登记/关联、手机适配 | ~260 行 + CSS ~180 行 |
| W3 | 健壮性：改名监听、精确匹配、失效提示、生成中禁用、文件浏览器禁用兜底、单测/E2E | ~80 行 |
| W4（可选） | 服务端按用户存偏好 + 会话同步，支持多设备 | 独立评估 |

**不做**：新增独立按钮、全屏浮层、多主目录、历史消息迁移、首期服务端会话同步。

## 七、验收清单

- 390 / 320 / 430 宽：无横向溢出，输入框始终可见，二级/三级内部滚动；
- 深色/浅色：边框、路径、失效警告对比度正常；
- 切换后标签立即更新；刷新后仍保持；只影响当前会话；
- 新会话默认开关生效；关闭后新会话跟随全局；
- 关联只读可增删、最多 3 个、主目录不可重复关联；
- 目录被删/改名/root 表清空：有可见提示与重选入口；
- 生成中无法切换；`workspace-renamed` 后标签即时更新；
- 文件浏览器禁用或 `PLITE_FS_SESSION=0`：不崩，手输路径兜底可用。
