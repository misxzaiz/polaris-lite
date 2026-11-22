# demo-mcp

零依赖的 Node.js stdio MCP server，用于测试 polaris-lite 的 MCP 安装链路。

## 工具

| 工具  | 参数                 | 说明                     |
| ----- | -------------------- | ------------------------ |
| echo  | message: string      | 原样回显文本             |
| now   | 无                   | 返回服务器当前 ISO 时间  |
| add   | a: number, b: number | 两数求和                 |

## 本地冒烟测试

```cmd
(echo {"jsonrpc":"2.0","id":1,"method":"initialize"} & echo {"jsonrpc":"2.0","id":2,"method":"tools/list"} & echo {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add","arguments":{"a":2,"b":40}}}) | node server.mjs
```

## 在 polaris-lite 安装

- name: `demo-mcp`（若校验拒绝中划线，改用 `demomcp`）
- command: `node`
- args: `["D:\\space\\base\\polaris-lite\\mcp-demo\\server.mjs"]`

安装成功后，下一轮对话会出现 `mcp__demo_mcp__echo / now / add`（或对应前缀）工具。
