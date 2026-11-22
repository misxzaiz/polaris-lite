# 全局 Hook 测试报告（v3 终版）

## 目标

验证 polaris-lite 平台的 hooks 是否真实生效。测试了三级 settings：
- A. 工作区级（项目根）：`D:\space\base\polaris-lite\.claude\settings.json`
- B. 工作区内部：`.polaris-lite\workspace\.claude\settings.json`
- C. 用户级：`C:\Users\28409\.claude\settings.json`

日志文件：`.polaris-lite\workspace\.claude\hook-log.jsonl`（已验证可写，PROBE-6191 成功追加）。

## Hook 配置

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "cmd /c echo [PreToolUse] %date% %time% >> <日志绝对路径>" }] }],
    "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "cmd /c echo [PostToolUse] %date% %time% >> <日志绝对路径>" }] }]
  }
}
```

## 测试过程与结果

| 步骤 | 操作 | 结果 |
| --- | --- | --- |
| 1 | 写入 workspace 内 settings.json（B） | ✅ 写入成功，但相对路径日志失败（exit=1），后修正 |
| 2 | 写入项目根 .claude/settings.json（A），路径用 %CD% | ✅ 写入成功 |
| 3 | 日志文件可写性探测（PROBE-6191） | ✅ 追加成功 |
| 4 | 用户面板确认 hook（interactive confirm） | ✅ confirmed=true |
| 5 | 批准后触发 bash 调用，检查日志 | ❌ 无 [PreToolUse]/[PostToolUse] 记录 |
| 6 | 写入用户级 settings.json（C），node 脚本改写，确认 hooks 键存在 | ✅ 写入成功 |
| 7 | 再次触发 bash 调用，检查日志 | ❌ 仍无 hook 记录 |
| 8 | 检查宿主进程 | polaris.exe (PID 8504) 存在，wmic 查其命令行无输出 |
| 9 | 用户确认后移除用户级 settings 的 hooks 键 | ✅ 已还原（findstr 确认无 hooks） |

## 结论

**三级 settings（项目根 / workspace 内 / 用户级）写入 hooks 均未使 hook 实际执行。** 日志文件本身可写（PROBE-6191 证明），排除路径问题；用户已确认授权，排除审批问题。因此判定：

> 当前 polaris-lite 宿主运行时**没有实现（或没有加载执行）settings.json 中的 hooks 配置**。系统提示中描述的"工作区钩子需用户确认后执行"机制在本环境中未观察到实际效果。

## 可能原因

1. 宿主（polaris.exe）未实现 hooks 事件分发，settings 里的 hooks 键被忽略；
2. hooks 仅在特定会话类型/渠道生效（如 Claude Code CLI，而非 polaris-lite 面板会话）；
3. matcher 或 command 需要平台特定格式，当前标准 Claude Code 格式不被识别。

## 遗留物与注意事项

- `.claude/settings.json`（项目根）与 `.polaris-lite\workspace\.claude\settings.json`：保留 hook 配置（工作区级，可留作后续复测）
- `C:\Users\28409\.claude\settings.json`：测试写入的 hooks 键**已移除还原**（经用户确认）
- `.polaris-lite\workspace\.claude\hook-log.jsonl`：测试日志（manual test / direct / PROBE-6191）
- 本报告：`.claude\hook-test-report.md`（项目根）与 workspace 内 `.claude\hook-test-report.md`
- 嵌套误写目录 `.polaris-lite\workspace\.polaris-lite\`：已清理

状态：**测试完成，结论为 hooks 未生效；用户级配置已还原**。
