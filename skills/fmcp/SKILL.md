---
name: fmcp
description: 使用 fmcp / figma-mcp 命令行访问 Figma 远程 MCP。用户要求通过 fmcp 获取设计上下文、生成参考代码、读取变量或元数据、截图、查询 Code Connect、列出或调用 Figma MCP 工具、检查登录状态，以及安装 Figma skills 时使用。
---

# fmcp 使用方法

`fmcp` 把 Figma 远程 MCP 服务器（`https://mcp.figma.com/mcp`）封装为终端命令。`figma-mcp` 是等价别名。通过 shell 执行命令，不要把 `fmcp` 当作当前 agent 的内置工具。

## 使用前检查

需要 Node.js >= 18.17，并确保 `fmcp` 已安装且在 PATH 中：

```bash
fmcp status --offline
```

未登录时，先征得用户同意再执行 `fmcp login`，因为命令会打开浏览器完成 OAuth 授权并等待回调。不要尝试使用 Figma Personal Access Token 代替 OAuth；远程 MCP 不接受这种认证方式。

```bash
fmcp login
fmcp status
fmcp tools
```

可用 `fmcp login --no-open` 仅输出授权链接。令牌保存在本地，过期后由 CLI 自动刷新。

## 获取设计信息

快捷命令接受完整 Figma 链接，或节点 ID 加 `--file-key`。链接会自动解析出 `nodeId` 和 `fileKey`，优先使用链接形式：

```bash
fmcp design-context "https://www.figma.com/design/FILE_KEY/Page?node-id=123-456"
fmcp code "https://www.figma.com/design/FILE_KEY/Page?node-id=123-456" --language typescript --framework react
fmcp variables "https://www.figma.com/design/FILE_KEY/Page?node-id=123-456"
fmcp metadata "https://www.figma.com/design/FILE_KEY/Page?node-id=123-456"
fmcp screenshot "https://www.figma.com/design/FILE_KEY/Page?node-id=123-456" --save-media ./out
fmcp code-connect "https://www.figma.com/design/FILE_KEY/Page?node-id=123-456"
fmcp context "https://www.figma.com/design/FILE_KEY/Page?node-id=123-456"
```

节点 ID 形式：

```bash
fmcp design-context 123:456 --file-key FILE_KEY
fmcp variables 123:456 --file-key FILE_KEY
fmcp code 123:456 --file-key FILE_KEY --language "html,css,typescript" --framework react
```

快捷命令用途：

- `design-context`：设计上下文、参考代码、截图和元数据。
- `code`：强制 `get_design_context` 返回代码。
- `variables`：变量和 design tokens。
- `metadata`：节点层级与 XML 元数据。
- `screenshot`：节点截图；`--save-media <目录>` 保存返回的媒体。
- `code-connect`：Code Connect 映射。
- `context`：供 Code Connect 使用的组件结构化元数据。

`--language` 和 `--framework` 的值是逗号分隔字符串，不是数组。

当任务要求把 Figma 设计实现为代码时，同时遵循适用的 Figma design-to-code skill；不要仅凭截图猜测设计。已安装对应 skill 时，可将其名称传给服务端：

```bash
fmcp design-context "<Figma链接>" --skills figma-design-to-code
```

## 调用任意 MCP 工具

先查询服务端当前工具和 schema，不要假定工具或参数始终不变：

```bash
fmcp tools
fmcp tools --schemas
fmcp tools --json
```

调用工具：

```bash
fmcp call whoami
fmcp call get_design_context --args '{"nodeId":"123:456","fileKey":"FILE_KEY"}'
fmcp call get_variable_defs --arg nodeId=123:456 --arg fileKey=FILE_KEY
fmcp call get_design_context --file args.json
fmcp call get_screenshot --arg nodeId=123:456 --arg fileKey=FILE_KEY --save-media ./out
```

参数优先级为 `--file` < `--args` < `--arg`，后面的来源覆盖前面的同名参数。参数值中如出现 Figma 链接，CLI 会自动展开 `nodeId` 和 `fileKey`，显式传入的值优先。

需要控制输出或请求时，可使用：

```bash
fmcp tools --json
fmcp design-context "<Figma链接>" --timeout 60000
fmcp design-context "<Figma链接>" --verbose
fmcp design-context "<Figma链接>" --quiet
```

## Figma 文件会话

新版文件类工具可能需要 `sessionId`。需要 `fileKey` 的快捷命令通常会自动调用 `create_session`。也可以显式控制：

```bash
fmcp design-context "<Figma链接>" --session SESSION_UUID
fmcp design-context "<Figma链接>" --no-session
```

优先复用同一次任务中的会话；只有确认目标只读工具不需要会话时才使用 `--no-session`。

## 安装和管理 Figma skills

```bash
fmcp skill list
fmcp skill list --source builtin
fmcp skill list --source community
fmcp skill list --filter token
fmcp skill install fmcp --scope user
fmcp skill install figma-design-to-code --scope user
fmcp skill install figma-design-to-code --scope project
fmcp skill installed --scope user
fmcp skill path --scope user
fmcp skill remove fmcp --scope user
```

`--scope user` 安装到 `~/.agents/skills`，`--scope project` 安装到当前项目的 `.agents/skills`。也可用 `--client agents|codex|claude|cursor|fmcp` 或 `--dir <路径>` 指定目标。目标已存在时，只有用户明确要求覆盖才加 `--force`。

## 作为 MCP stdio 服务

如果 MCP 客户端需要 stdio 服务，可配置：

```toml
[mcp_servers.Figma]
command = "fmcp"
args = ["serve"]
```

`serve` 负责认证、连接和重试，并转发上游 `tools/list` 与 `tools/call`。

## 输出与故障处理

- 默认输出适合直接阅读；`--json` 用于脚本或管道处理。
- 截图 URL 可能短时有效；需要保留时立即使用 `--save-media`。
- 遇到认证错误时先运行 `fmcp status`，不要输出或复制本地凭据文件。
- Windows PowerShell 管道若因 BOM 导致 JSON 解析失败，可在 PowerShell 中设置无 BOM 的 UTF-8 输出，或改用 `cmd /c "fmcp ..."` 后再接管道。
- 命令失败时保留原始错误信息，先检查链接、节点 ID、file key、登录状态和服务端工具 schema，再重试。
