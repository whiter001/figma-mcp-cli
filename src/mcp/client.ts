import { log } from '../util/logger.js';

export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly rpcError?: JsonRpcError,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export class AuthError extends Error {
  constructor(message = '认证失败 (401): 令牌无效或已过期') {
    super(message);
    this.name = 'AuthError';
  }
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface ResourceContent {
  type: 'resource';
  resource: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

export interface EmbeddedResource {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
}

export type ToolContent = TextContent | ImageContent | ResourceContent | EmbeddedResource;

export interface CallToolResult {
  content?: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpClientOptions {
  serverUrl: string;
  accessToken: string;
  protocolVersion?: string;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * A minimal MCP client speaking the Streamable HTTP transport.
 * Works against the Figma remote MCP server (https://mcp.figma.com/mcp).
 */
export class McpClient {
  private readonly serverUrl: string;
  private readonly accessToken: string;
  private readonly timeoutMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private protocolVersion: string;
  private sessionId?: string;
  private nextId = 1;
  private initialized = false;

  constructor(options: McpClientOptions) {
    this.serverUrl = options.serverUrl;
    this.accessToken = options.accessToken;
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.clientName = options.clientName ?? 'fmcp';
    this.clientVersion = options.clientVersion ?? '0.1.0';
  }

  get negotiatedProtocolVersion(): string {
    return this.protocolVersion;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Perform the MCP `initialize` handshake. */
  async initialize(): Promise<{ protocolVersion: string; serverInfo?: { name?: string; version?: string }; capabilities?: unknown }> {
    const result = await this.request('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: this.clientName, version: this.clientVersion },
    });

    const info = result as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      capabilities?: unknown;
    };

    if (info?.protocolVersion) this.protocolVersion = info.protocolVersion;

    await this.notify('notifications/initialized', {});
    this.initialized = true;

    return {
      protocolVersion: this.protocolVersion,
      ...(info?.serverInfo ? { serverInfo: info.serverInfo } : {}),
      ...(info?.capabilities !== undefined ? { capabilities: info.capabilities } : {}),
    };
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request('tools/list', {});
    const tools = (result as { tools?: McpTool[] })?.tools ?? [];
    return tools;
  }

  async listResources(): Promise<unknown[]> {
    const result = await this.request('resources/list', {});
    return (result as { resources?: unknown[] })?.resources ?? [];
  }

  async listPrompts(): Promise<unknown[]> {
    const result = await this.request('prompts/list', {});
    return (result as { prompts?: unknown[] })?.prompts ?? [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    return (result ?? {}) as CallToolResult;
  }

  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    const messages = await this.post(payload, timeoutMs ?? this.timeoutMs);
    const response = messages.find((m): m is JsonRpcResponse => m.id === id);

    if (!response) {
      throw new McpError(`没有收到 id=${id} 的响应 (${method})`);
    }
    if (response.error) {
      throw new McpError(`${response.error.message} (${method})`, response.error);
    }
    return response.result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params }, 30_000, false);
  }

  /** Best-effort session teardown (the server may be stateless). */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(this.serverUrl, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'mcp-session-id': this.sessionId,
          'mcp-protocol-version': this.protocolVersion,
        },
      });
    } catch {
      /* ignore */
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.accessToken}`,
      'user-agent': `${this.clientName}/${this.clientVersion}`,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.initialized) headers['mcp-protocol-version'] = this.protocolVersion;
    return headers;
  }

  private async post(
    payload: unknown,
    timeoutMs: number,
    expectResponse = true,
  ): Promise<JsonRpcResponse[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.serverUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error && err.name === 'AbortError'
        ? `请求超时 (${timeoutMs}ms)`
        : `网络请求失败: ${(err as Error).message}`;
      throw new McpError(message);
    } finally {
      clearTimeout(timer);
    }

    const sessionId = res.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;

    if (res.status === 401) throw new AuthError();

    const contentType = res.headers.get('content-type') ?? '';

    if (!expectResponse) {
      await res.text().catch(() => '');
      if (res.status >= 400) {
        throw new McpError(`通知失败 (HTTP ${res.status})`, undefined, res.status);
      }
      return [];
    }

    const body = await res.text();

    if (!res.ok) {
      throw new McpError(`HTTP ${res.status}: ${body.slice(0, 500)}`, undefined, res.status);
    }

    if (contentType.includes('text/event-stream')) {
      return parseSse(body);
    }

    if (!body.trim()) return [];

    try {
      const parsed = JSON.parse(body) as JsonRpcResponse | JsonRpcResponse[];
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (err) {
      log.debug(`无法解析响应: ${(err as Error).message}`);
      return [];
    }
  }
}

/** Parse a Server-Sent Events body into JSON-RPC messages. */
export function parseSse(body: string): JsonRpcResponse[] {
  const messages: JsonRpcResponse[] = [];
  let dataLines: string[] = [];

  const flush = (): void => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    dataLines = [];
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse | JsonRpcResponse[];
      if (Array.isArray(parsed)) messages.push(...parsed);
      else messages.push(parsed);
    } catch {
      /* ignore malformed frames */
    }
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();

  return messages;
}
