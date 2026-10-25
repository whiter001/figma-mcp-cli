import { log } from '../util/logger.js';
import { connect } from './context.js';
import { renderToolResult } from './output.js';
import { parseTarget } from '../util/figma-url.js';
import { parseKeyValueArgs } from './call.js';
import type { CallToolResult, McpClient } from '../mcp/client.js';

export interface ShortcutSpec {
  /** Upstream MCP tool name. */
  tool: string;
  /** The tool needs a node id. */
  target: boolean;
  /** The tool needs a file key. */
  file: boolean;
  /** Include clientLanguages / clientFrameworks. */
  typed?: boolean;
  /** Extra fixed arguments merged into the call. */
  extra?: Record<string, unknown>;
  description: string;
}

export const SHORTCUTS: Record<string, ShortcutSpec> = {
  'design-context': {
    tool: 'get_design_context',
    target: true,
    file: true,
    typed: true,
    description: '获取设计上下文（参考代码 + 截图 + 元数据）',
  },
  code: {
    tool: 'get_design_context',
    target: true,
    file: true,
    typed: true,
    extra: { forceCode: true },
    description: '强制获取设计代码（get_design_context + forceCode）',
  },
  variables: {
    tool: 'get_variable_defs',
    target: true,
    file: true,
    description: '获取变量定义 (tokens)',
  },
  metadata: {
    tool: 'get_metadata',
    target: false,
    file: true,
    description: '获取节点层级与元数据 (XML)',
  },
  screenshot: {
    tool: 'get_screenshot',
    target: true,
    file: true,
    description: '获取节点截图',
  },
  'code-connect': {
    tool: 'get_code_connect_map',
    target: true,
    file: true,
    description: '获取 Code Connect 映射',
  },
  context: {
    tool: 'get_context_for_code_connect',
    target: true,
    file: true,
    description: '获取组件结构化元数据（属性 / 变体 / 子节点树）',
  },
};

export interface ShortcutOptions {
  json?: boolean;
  saveMedia?: string;
  /** Comma separated language list, e.g. "typescript". */
  language?: string[];
  /** Comma separated framework list, e.g. "react". */
  framework?: string[];
  /** Explicit file key, when the target does not contain one. */
  fileKey?: string;
  /** skillNames to report to the server (comma separated). */
  skills?: string;
  /** Reuse an existing session UUID. */
  session?: string;
  /** Skip create_session. */
  noSession?: boolean;
  /** Extra raw arguments passed straight to the tool. */
  arg?: string[];
  timeoutMs?: number;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export async function shortcut(
  name: string,
  target: string | undefined,
  options: ShortcutOptions = {},
): Promise<void> {
  const spec = SHORTCUTS[name];
  if (!spec) throw new Error(`未知快捷命令: ${name}`);

  const parsed = target ? parseTarget(target) : undefined;
  const fileKey = options.fileKey ?? parsed?.fileKey;
  const nodeId = parsed?.nodeId;

  if (spec.file && !fileKey) {
    throw new Error(
      `缺少 fileKey。请传入完整的 Figma 链接（https://www.figma.com/design/<fileKey>/...），` +
        `或用 --file-key <key> 指定。`,
    );
  }
  if (spec.target && !nodeId) {
    throw new Error(
      `缺少节点 ID。请传入带 ?node-id= 的 Figma 链接，或直接给节点 ID（如 1:23）。`,
    );
  }

  const { client } = await connect({ timeoutMs: options.timeoutMs ?? 180_000 });

  const args: Record<string, unknown> = { ...spec.extra };

  if (nodeId) args.nodeId = nodeId;
  if (fileKey) args.fileKey = fileKey;

  if (spec.typed) {
    // Figma expects comma separated strings here, not arrays.
    args.clientLanguages = (options.language?.length ? options.language : ['typescript']).join(',');
    args.clientFrameworks = (options.framework?.length ? options.framework : ['react']).join(',');
  }

  // `skillNames` tells the server which skills the caller is following.
  if (options.skills) {
    args.skillNames = options.skills;
  }

  // Figma's file tools expect a session UUID; create one unless told not to.
  if (fileKey && !options.noSession) {
    const sessionId = options.session ?? (await createSession(client, fileKey, name));
    if (sessionId) args.sessionId = sessionId;
  }

  Object.assign(args, parseKeyValueArgs(options.arg));

  const result = await client.callTool(spec.tool, args);
  await client.close();

  log.out(await renderToolResult(result, { json: options.json, saveMedia: options.saveMedia }));
}

/** Create a Figma task session and return its UUID. */
export async function createSession(
  client: McpClient,
  fileKey: string,
  description: string,
): Promise<string | undefined> {
  try {
    const result = (await client.callTool('create_session', {
      fileKey,
      description: `fmcp: ${description}`,
    })) as CallToolResult;

    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('\n');

    const structured = JSON.stringify(result.structuredContent ?? '');
    const match = `${text}\n${structured}`.match(UUID_RE);
    if (match) return match[0];

    log.warn('create_session 未返回可识别的 sessionId，继续不带 sessionId 调用。');
    return undefined;
  } catch (err) {
    log.warn(`create_session 失败: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
