# ext-plugins-src — polaris-lite 外部插件示例源

供 plugin-market（`/api/market/*`）以 **dir 源** 方式安装的外部插件示例库。
当前包含 `extquad`：一个「面板 + Skill + MCP + Hook」四合一验证插件。

## 目录结构（dir 源契约）

```
ext-plugins-src/
├── index.json              # 源清单：{ name, plugins: [{ id, name, version, description, sha256 }] }
└── extquad/                # 插件包目录（目录名 = 插件 id）
    ├── plugin.json         # manifest（id 必须与目录名一致；声明 panel 槽位）
    ├── plugin.js           # 构建产物（与 index.json 的 sha256 一致；安装器强校验）
    ├── style.css           # 可选样式
    ├── index.tsx           # 源码：面板组件 + LitePlugin 导出
    ├── mcp-server.mjs      # 随包 stdio MCP server（echo 工具，JSON-RPC 2.0）
    └── vite.config.ts      # 独立构建配置（@sdk 别名 → plugins/sdk；react 走宿主 import map）
```

## 构建

```bash
npx vite build --config ext-plugins-src/extquad/vite.config.ts
cp ext-plugins-src/extquad/dist/plugin.js ext-plugins-src/extquad/plugin.js
cp ext-plugins-src/extquad/dist/style.css ext-plugins-src/extquad/style.css
# 更新 index.json 中 plugin.js 的 sha256（安装器会拒绝指纹不符的包）
```

## 安装（在 polaris-lite 商城面板或 API）

1. 添加 dir 源：`{ "name": "local-ext", "type": "dir", "ref": "<本仓库绝对路径>/ext-plugins-src" }`
2. 安装：`POST /api/market/install { "source": "local-ext", "id": "extquad" }`
3. 刷新页面 → 面板区出现「extquad 验证台」。

## 四通道说明

| 通道 | 生效方式 |
| --- | --- |
| 面板 | 刷新页面即加载（动态 import `/ext-plugins/<id>/plugin.js`） |
| Skill | 面板按钮把 SKILL.md 写入 `<workspace>/.claude/skills/extquad-note/`，下轮对话进系统提示附录 |
| MCP | 面板按钮登记 `extquad-echo` 到 `mcp-servers.json`；**注意 args 是本机绝对路径，克隆后需按实际路径调整** |
| Hook | 面板按钮写入 `<workspace>/.claude/settings.json` 的 PostToolUse 规则，钩子面板确认后执行 |

## 安全提示

- 外部插件与宿主**同进程**运行，只安装可信来源；安装器会做 sha256 强校验与 manifest 校验。
- `dist/` 为构建中间产物，不入库（.gitignore 已忽略）；包根的 `plugin.js` 才是安装器消费的产物。
- 未在 grants.json 登记的插件按 `unlistedPolicy: declare` 放行并出现权限告警；要收编请把授权写进 `public/grants.json`。
