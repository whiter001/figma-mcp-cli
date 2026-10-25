#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { setLogLevel, log, type LogLevel } from './util/logger.js';
import { packageVersion } from './util/version.js';
import { login, DEFAULT_CLIENT_NAME } from './commands/login.js';
import { logout } from './commands/logout.js';
import { status } from './commands/status.js';
import { tools } from './commands/tools.js';
import { call } from './commands/call.js';
import { shortcut, SHORTCUTS } from './commands/shortcuts.js';
import { skillCommand } from './commands/skill.js';
import { serve } from './commands/serve.js';

const VERSION = packageVersion();

const HELP = `
fmcp ${VERSION} — 直接在命令行调用 Figma MCP (https://mcp.figma.com/mcp)

用法:
  fmcp <命令> [参数] [选项]

  （等价别名: figma-mcp，两种敲法都行）

命令:
  login                    登录 Figma（OAuth 2.1 + PKCE，浏览器授权）
  logout                   清除本地凭据
  status                   查看登录状态、令牌有效期与可用工具
  tools                    列出服务端暴露的工具
  call <工具名>            调用任意 MCP 工具
  design-context <目标>    获取设计上下文（参考代码 + 截图 + 元数据）
  code <目标>              强制获取设计代码（get_design_context + forceCode）
  variables <目标>         获取变量定义 (tokens)
  metadata <目标>          获取节点层级与元数据 (XML)
  screenshot <目标>        获取节点截图
  code-connect <目标>      获取 Code Connect 映射
  context <目标>           获取组件结构化元数据（属性/变体/子节点树）
  skill <子命令>          管理 Figma skills（list / install / remove / installed）
  serve                    以 stdio MCP 服务器方式运行（可挂回任意 MCP 客户端）
  help                     显示本帮助

  <目标> 可以是 Figma 链接（自动解析 node-id 与 fileKey）或节点 ID（如 1:23）

全局选项:
  --json                   以 JSON 输出（便于脚本/管道处理）
  --timeout <毫秒>         单次请求超时时间
  --verbose                输出调试日志
  --quiet                  只输出错误

命令专属选项:
  login      --client-name <名称>   DCR 注册时使用的 client_name
             --no-open              不自动打开浏览器，只打印授权链接
  call       --args <json>          整体 JSON 参数
             --arg <key=value>      单个参数（可重复）
             --file <path>          从 JSON 文件读取参数
  skill      --client <id>          安装目标: agents / claude / codex / cursor / fmcp
             --scope <user|project> user=~/.agents/skills, project=./.agents/skills
             --dir <路径>            直接指定安装目录
             --source <id>          list 时过滤: official / community
             --filter <关键词>       list 时按名称/描述/工具过滤
             --refresh              刷新本地 skill 目录缓存
             --force                覆盖已安装的同名 skill
  快捷命令    --language <语言>      逗号分隔或可重复，默认 typescript
             --framework <框架>      逗号分隔或可重复，默认 react
             --file-key <key>       目标里没有链接时手动指定 fileKey
             --session <uuid>       复用已有的 Figma 会话 UUID
             --no-session           不创建会话
             --skills <名称列表>     传给服务端的 skillNames（逗号分隔）
             --arg <key=value>      追加/覆盖参数
  任意命令    --save-media <目录>    把图片等二进制内容保存到目录

示例:
  fmcp login --client-name Codex
  fmcp design-context "https://www.figma.com/design/XXXX/Page?node-id=1-23"
  fmcp code 1:23 --file-key XXXX --language typescript --framework react
  fmcp call get_variable_defs --arg nodeId=123:456 --arg fileKey=XXXX
  fmcp tools --json | jq '.[].name'
  fmcp skill list
  fmcp skill install figma-design-to-code --client agents
  fmcp skill install figma-design-to-code --scope project

在 MCP 客户端中改用本 CLI（替代 url = "https://mcp.figma.com/mcp"）:
  [mcp_servers.Figma]
  command = "fmcp"
  args = ["serve"]
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // --help / --version are consumed by parseArgs as options, so handle them first.
  if (argv.some((a) => a === '--help' || a === '-h')) {
    log.out(HELP);
    return;
  }
  if (argv.some((a) => a === '--version' || a === '-v' || a === 'version')) {
    log.out(VERSION);
    return;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: {
        json: { type: 'boolean' },
        verbose: { type: 'boolean' },
        quiet: { type: 'boolean' },
        timeout: { type: 'string' },
        'client-name': { type: 'string' },
        'no-open': { type: 'boolean' },
        offline: { type: 'boolean' },
        schemas: { type: 'boolean' },
        args: { type: 'string' },
        arg: { type: 'string', multiple: true },
        file: { type: 'string' },
        language: { type: 'string', multiple: true },
        framework: { type: 'string', multiple: true },
        'save-media': { type: 'string' },
        'file-key': { type: 'string' },
        session: { type: 'string' },
        'no-session': { type: 'boolean' },
        client: { type: 'string' },
        dir: { type: 'string' },
        scope: { type: 'string' },
        source: { type: 'string' },
        filter: { type: 'string' },
        force: { type: 'boolean' },
        refresh: { type: 'boolean' },
        skills: { type: 'string' },
      },
    });
  } catch (err) {
    log.error(`参数错误: ${(err as Error).message}`);
    log.out(HELP);
    process.exit(2);
  }

  const values = parsed.values as Record<string, string | string[] | boolean | undefined>;
  const positionals = parsed.positionals;

  const level: LogLevel = values.quiet ? 'silent' : values.verbose ? 'debug' : 'info';
  setLogLevel(level);

  const timeoutMs = values.timeout ? Number(values.timeout) : undefined;
  if (timeoutMs !== undefined && Number.isNaN(timeoutMs)) {
    log.error('--timeout 必须是数字（毫秒）');
    process.exit(2);
  }

  const str = (key: string): string | undefined => {
    const value = values[key];
    return typeof value === 'string' ? value : undefined;
  };
  const list = (key: string): string[] | undefined => {
    const value = values[key];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return [value];
    return undefined;
  };

  const [command, ...rest] = positionals;

  if (!command || command === 'help') {
    log.out(HELP);
    return;
  }

  switch (command) {
    case 'login':
      await login({
        clientName: str('client-name') ?? DEFAULT_CLIENT_NAME,
        noOpen: values['no-open'] === true,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      return;

    case 'logout':
      logout();
      return;

    case 'status':
      await status({ json: values.json === true, offline: values.offline === true });
      return;

    case 'tools':
      await tools({ json: values.json === true, schemas: values.schemas === true });
      return;

    case 'call': {
      const toolName = rest[0];
      if (!toolName) {
        log.error('用法: figma-mcp call <工具名> [--args <json>] [--arg key=value]');
        process.exit(2);
      }
      await call(toolName, {
        json: values.json === true,
        ...(str('args') ? { args: str('args') } : {}),
        ...(list('arg') ? { arg: list('arg') } : {}),
        ...(str('file') ? { file: str('file') } : {}),
        ...(str('save-media') ? { saveMedia: str('save-media') } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      return;
    }

    case 'serve':
      await serve(timeoutMs ? { timeoutMs } : {});
      return;

    case 'skill': {
      const [subcommand, ...skillArgs] = rest;
      await skillCommand(subcommand, skillArgs, {
        json: values.json === true,
        ...(str('source') ? { source: str('source') } : {}),
        ...(str('client') ? { client: str('client') } : {}),
        ...(str('dir') ? { dir: str('dir') } : {}),
        ...(str('scope') ? { scope: str('scope') } : {}),
        ...(str('filter') ? { filter: str('filter') } : {}),
        ...(values.force === true ? { force: true } : {}),
        ...(values.refresh === true ? { refresh: true } : {}),
      });
      return;
    }

    default: {
      if (command in SHORTCUTS) {
        await shortcut(command, rest[0], {
          json: values.json === true,
          ...(list('language') ? { language: list('language') } : {}),
          ...(list('framework') ? { framework: list('framework') } : {}),
          ...(str('file-key') ? { fileKey: str('file-key') } : {}),
          ...(str('skills') ? { skills: str('skills') } : {}),
          ...(str('session') ? { session: str('session') } : {}),
          ...(values['no-session'] === true ? { noSession: true } : {}),
          ...(list('arg') ? { arg: list('arg') } : {}),
          ...(str('save-media') ? { saveMedia: str('save-media') } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        });
        return;
      }
      log.error(`未知命令: ${command}`);
      log.out(HELP);
      process.exit(2);
    }
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  if (process.env.FIGMA_MCP_DEBUG && err instanceof Error && err.stack) {
    log.error(err.stack);
  }
  process.exit(1);
});
