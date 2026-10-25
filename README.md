# fmcp

把 Figma 的远程 MCP 服务器（`https://mcp.figma.com/mcp`）封装成一个命令行工具，
**不再需要**在 MCP 客户端里配置 `[mcp_servers.Figma] url = "https://mcp.figma.com/mcp"`。

```bash
fmcp design-context "https://www.figma.com/design/XXXX/Page?node-id=1-23"
fmcp variables 123:456 --file-key XXXXXXXXXXXXXXXXXXXX
fmcp code 123:456 --file-key XXXXXXXXXXXXXXXXXXXX --language typescript
fmcp tools --json | jq '.[].name'
```

> 命令名是 **`fmcp`**（4 个字符）。`figma-mcp` 作为等价别名同时保留，两种敲法都可用。

---

## 为什么需要它

MCP 客户端（Codex / Claude Code / Cursor …）通过配置项把远程 MCP 服务器接进来，
代价是：每次会话都要维护连接、工具会常驻占用上下文、调试链路长。

本工具把同一条链路搬到终端里：

| 场景 | MCP 客户端配置 | 本 CLI |
| --- | --- | --- |
| 取设计上下文 | 客户端自动调用 `get_design_context` | `fmcp design-context <链接>` |
| 脚本 / CI 里取数 | 需要额外写 MCP 客户端 | `fmcp call get_variable_defs --args '{...}' \| jq` |
| 想要 MCP 客户端能力 | 配 `url` | 配 `command = "fmcp"`，`args = ["serve"]`（见下文） |

协议层面完全等价：CLI 走的是 MCP Streamable HTTP 传输 + JSON-RPC，
和 `url = "https://mcp.figma.com/mcp"` 是同一条链路、同一个服务端、同一套工具
（实测 45 个工具，转发原样透传）。

---

## 安装

```bash
# 全局安装
npm install -g @whiter001/fmcp

# 或从源码运行
npm install
npm run build
node dist/cli.js help
```

> 需要 Node.js >= 18.17（`fetch` 原生可用）。本工具**零运行时依赖**。
>
> **关于命名**：npm 的名称相似度策略不允许发布全局名 `fmcp`（与 `ftp`/`ncp`/`mcp1`/`tmp` 过于接近），
> 官方报错里建议改用作用域包，因此包名为 `@whiter001/fmcp`。
> 安装后 `fmcp` 和 `figma-mcp` 两个命令都可用。

### Windows PowerShell 管道注意

npm 生成的 `fmcp.ps1` 启动脚本会用 PowerShell 的编码重新输出，**在开头插入 BOM**，
导致 `fmcp --json | jq` 报 `Expected a value at line 1, column 1`。
（本 CLI 自身输出的是无 BOM 的 UTF-8，问题只出在 PowerShell 管道上。）

在 PowerShell 里执行前加两行即可，或直接用 `cmd /c`：

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
fmcp variables "<链接>" | jq 'keys | length'
```

```cmd
cmd /c "fmcp variables <链接>" | jq "keys | length"
```

---

## 快速开始

```bash
# 1. 登录（浏览器完成 OAuth 授权，命令会等待回调）
fmcp login

# 2. 看看连上了什么
fmcp status
fmcp tools

# 3. 干活
fmcp design-context "https://www.figma.com/design/XXXX/Page?node-id=1-23"
```

登录一次即可，令牌加密保存在本地，过期会自动刷新。

---

## 命令参考

### `fmcp login`

执行 OAuth 2.1 + PKCE 登录：动态注册客户端 → 打开浏览器授权 → 本地回环端口接收
授权码 → 换取令牌并加密落盘。

```bash
fmcp login
fmcp login --client-name Codex     # 指定 DCR 注册时使用的 client_name
fmcp login --no-open               # 不自动开浏览器，只打印授权链接
```

### `fmcp status`

```bash
fmcp status           # 登录状态、令牌有效期、可用工具清单
fmcp status --json    # 机器可读
fmcp status --offline # 只看本地状态，不请求服务端
```

### `fmcp tools`

列出服务端当前暴露的工具（以服务端实际返回为准，不写死）。

```bash
fmcp tools
fmcp tools --schemas  # 附带入参 schema
fmcp tools --json
```

### `fmcp call <工具名>`

调用任意工具，适合服务端新增工具后直接使用。

```bash
fmcp call whoami
fmcp call get_variable_defs --arg nodeId=1:23 --arg fileKey=XXXX
fmcp call get_design_context --args '{"nodeId":"1:23","fileKey":"XXXX"}'
fmcp call get_design_context --file args.json
fmcp call get_screenshot --arg nodeId=1:23 --arg fileKey=XXXX --save-media ./out
```

参数来源优先级：`--file` < `--args` < `--arg`（后者覆盖前者）。
另外，参数里只要出现一个 Figma 链接，就会自动展开成 `nodeId` / `fileKey`
（显式传入的值优先）。

### 快捷命令

`fmcp <快捷名> <目标>`，目标可以是 Figma 链接（自动解析 `node-id` 与 `fileKey`）
或节点 ID（`123:456`）。

| 快捷命令 | 对应工具 | 说明 |
| --- | --- | --- |
| `design-context` | `get_design_context` | 设计上下文：参考代码 + 截图 + 元数据 |
| `code` | `get_design_context` + `forceCode` | 强制返回代码 |
| `variables` | `get_variable_defs` | 变量 / tokens |
| `metadata` | `get_metadata` | 节点层级与元数据（XML） |
| `screenshot` | `get_screenshot` | 节点截图 |
| `code-connect` | `get_code_connect_map` | Code Connect 映射 |
| `context` | `get_context_for_code_connect` | 组件结构化元数据（属性 / 变体 / 子节点树） |

```bash
fmcp design-context "https://www.figma.com/design/XXXX/Page?node-id=123-456"
fmcp code 123:456 --file-key XXXX --language typescript --framework react
fmcp variables 123:456 --file-key XXXX
fmcp screenshot 123:456 --file-key XXXX --save-media ./out
```

> `--language` / `--framework` 传的是**逗号分隔字符串**（Figma 的 schema 就是 string，
> 不是数组）：`--language "html,css,typescript" --framework react`。

### `fmcp serve`（MCP 客户端接回来）

如果你仍然想用 MCP 客户端，但希望由本 CLI 承担认证、连接和重试，
把它当**命令**而不是 **url** 即可：

```toml
# ~/.codex/config.toml
[mcp_servers.Figma]
command = "fmcp"
args = ["serve"]
```

`serve` 会把上游 Figma MCP 服务器的 `tools/list`、`tools/call` 原样转发到 stdio。

### `fmcp skill`（给 agent 装 Figma skills）

Figma 的 skill 是给 agent 看的「怎么用这些 MCP 工具」说明书（SKILL.md）。
本命令直接从官方仓库和社区索引拉下来，装进对应 agent 的 skills 目录。

```bash
fmcp skill list                                  # 列出可安装的（官方 16 个 + 社区 ~30 个）
fmcp skill list --source community               # 只看社区
fmcp skill list --filter token                   # 按名称/描述/工具过滤
fmcp skill install figma-design-to-code          # 装到 ~/.agents/skills
fmcp skill install figma-design-to-code --scope project   # 装到 ./.agents/skills
fmcp skill install figma-design-to-code --client codex
fmcp skill install figma-design-to-code --dir D:\somewhere\skills
fmcp skill installed --client codex              # 列出已安装
fmcp skill path                                  # 打印目标目录
fmcp skill remove figma-design-to-code --client codex
```

**skill 来源**

| 来源 | 仓库 | 内容 |
| --- | --- | --- |
| 官方 | `figma/mcp-server-guide/skills` | `figma-design-to-code`、`figma-code-connect`、`figma-use`、`figma-spec`、`figma-generate-design` … 共 16 个 |
| 社区 | `figma/community-resources` 索引 | 约 30 个（`export-tokens-figma`、`import-tokens-figma`、`ds-init-figma`、`bridge-ds` …） |

**安装目标**（`--client` / `--scope`）

`.agents/skills` 是正在形成的跨客户端约定目录：技能放这里，兼容的代理都能扫到，
不必为每个工具各维护一份拷贝。

| 写法 | 目录 | 说明 |
| --- | --- | --- |
| `--scope user`（默认） | `~/.agents/skills/` | 本机通用，跨客户端共享 |
| `--scope project` | `./.agents/skills/` | 跟仓库走，可提交、团队共享 |
| `--client agents` | `~/.agents/skills/` | 同 `--scope user` |
| `--client codex` | `~/.codex/skills/` | Codex 私有目录 |
| `--client claude` | `~/.claude/skills/` | Claude Code 私有目录 |
| `--client cursor` | `~/.cursor/skills/` | Cursor 私有目录 |
| `--client fmcp` | `~/.fmcp/skills/` | fmcp 自有目录 |
| `--dir <路径>` | 任意 | 直接指定 |

不指定任何参数时自动探测 `~/.agents/skills` → `~/.codex/skills` → `~/.claude/skills` →
`~/.cursor/skills`；也可用环境变量 `FIGMA_MCP_SKILL_DIR` 指定。
安装记录在 `~/.fmcp/skills.json`（`fmcp skill installed` 可查）。

> 建议：同一个 skill 只保留一份（放在 `~/.agents/skills`），
> 老目录用软链过渡，避免三份拷贝各自漂移。
> 需要按客户端分开时用 `--client` 显式指定。

下载走 GitHub tarball，用 Node 内置 zlib 自己解 tar（无第三方依赖）；
设置 `GITHUB_TOKEN` 可提高 GitHub API 限额。

skill 目录会缓存到 `~/.fmcp/cache/catalog.json`（6 小时），`fmcp skill list` 秒开；
`--refresh` 强制刷新。索引优先走 GitHub API，`raw.githubusercontent.com` 只作兜底
（后者在部分网络下不可达）。

**和 `skillNames` 的关系**

Figma 的 `get_design_context` / `use_figma` 有一个 `skillNames` 参数，
用于声明本次调用正在遵循哪些 skill。装了 skill 之后可以一起带上：

```bash
fmcp design-context "<链接>" --skills figma-design-to-code
```

### 全局选项

| 选项 | 说明 |
| --- | --- |
| `--json` | 输出原始 JSON（便于管道处理） |
| `--timeout <毫秒>` | 单次请求超时 |
| `--verbose` / `--quiet` | 调试日志 / 只留错误 |
| `--save-media <目录>` | 把图片等二进制内容保存到目录 |

`get_screenshot` 返回的是**托管 URL**（短时有效），带 `--save-media` 时 CLI 会自动下载到目录。

---

## 认证是怎么做的

* **协议**：OAuth 2.1 Authorization Code + PKCE (S256)，带 `state` 校验；
  授权服务器元数据来自 `https://api.figma.com/.well-known/oauth-authorization-server`，
  受保护资源元数据来自 `https://mcp.figma.com/.well-known/oauth-protected-resource`。
* **客户端注册**：Dynamic Client Registration
  (`POST https://api.figma.com/v1/oauth/mcp/register`)。
  ⚠️ 该端点**只接受 Figma MCP 目录内的 client_name**，自定义名称返回 403；
  且**只接受 `application/json` 请求体**，form-urlencoded 同样返回 403。
  目前实测可用的名称：`Codex`、`opencode`、`Claude Code`。
  授权页面会显示所选名称，所以请选一个与你的使用场景相符的。
* **令牌存储**：`~/.figma-mcp/credentials.json`
  * Windows：DPAPI（CurrentUser 作用域）加密，同用户同机器才能解密；
  * 其他平台：AES-256-GCM，密钥在 `~/.figma-mcp/key`（`0600`）。
* **刷新**：访问令牌临近过期自动用 refresh_token 换新；遇到 401 会自动刷新并重试一次。

### Figma 会话（create_session）

远程服务器的新版文件类工具都带 `sessionId` 参数：先 `create_session`
（参数 `fileKey` + `description`）拿到 UUID，再在后续文件工具调用里带上它。
本 CLI 对快捷命令**自动完成**这一步：

* 需要 `fileKey` 的快捷命令会自动 `create_session`；
* `--session <uuid>` 可复用已有会话；
* `--no-session` 可跳过（部分只读工具不需要）。

### 已知限制

* **Figma 远程 MCP 不接受 Personal Access Token**：`X-Figma-Token` 与
  `Authorization: Bearer <PAT>` 都会得到 401。必须走 OAuth。
* **`client_name` 白名单**：Figma 暂未开放给第三方客户端开放注册
  （官方文档：需加入 Figma MCP 目录白名单）。本工具通过 `--client-name` 暴露该参数，
  后续 Figma 放开后可直接切换。
* **远程服务器没有 `get_code`**：那是桌面版服务器的工具。远程版用
  `get_design_context`（含参考代码），需要强制出代码时加 `forceCode`——
  本 CLI 的 `code` 快捷命令已经这么做了。

---

## 开发

```bash
npm install
npm run build          # tsc -> dist/
npm test               # node:test 单元测试
npm run smoke          # 对真实 Figma 服务器跑一遍 serve 桥接冒烟测试
```

目录结构：

```
src/
  cli.ts              命令行入口与参数解析
  auth/oauth.ts       DCR / PKCE / 授权回调 / 令牌交换与刷新
  auth/store.ts       凭据加密存储
  mcp/client.ts       MCP Streamable HTTP 客户端（JSON-RPC + SSE）
  mcp/stdio.ts        stdio MCP 桥接（serve 模式）
  commands/           login / logout / status / tools / call / 快捷命令 / skill / serve
  skills/             skill 目录（官方 + 社区）、安装与卸载
  util/               Figma 链接解析、tar 解包、加密、浏览器、日志
```

## License

MIT
