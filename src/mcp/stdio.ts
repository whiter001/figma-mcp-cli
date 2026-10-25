import { createInterface } from 'node:readline';
import { log } from '../util/logger.js';
import { packageVersion } from '../util/version.js';
import type { McpClient } from './client.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface StdioBridgeOptions {
  /** Creates a connected MCP client for the upstream (Figma) server. */
  createClient: () => Promise<McpClient>;
  /** Where diagnostics go — never stdout, that is the protocol channel. */
  onDiagnostic?: (message: string) => void;
}

/**
 * Run an MCP server on stdio that forwards tools to the upstream Figma MCP
 * server. This lets the CLI be used as a drop-in replacement for the
 * `[mcp_servers.Figma] url = "https://mcp.figma.com/mcp"` config entry:
 *
 *   [mcp_servers.Figma]
 *   command = "fmcp"
 *   args = ["serve"]
 */
export async function runStdioBridge(options: StdioBridgeOptions): Promise<void> {
  const diagnostic = options.onDiagnostic ?? ((message: string) => log.debug(message));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  let client: McpClient | undefined;

  const send = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const respond = (id: number | string | null, result: unknown): void => {
    send({ jsonrpc: '2.0', id, result });
  };

  const respondError = (id: number | string | null, code: number, message: string, data?: unknown): void => {
    send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  };

  const getClient = async (): Promise<McpClient> => {
    if (!client) {
      diagnostic('connecting to upstream MCP server...');
      // The factory returns an already-initialized client.
      client = await options.createClient();
      diagnostic('upstream connected');
    }
    return client;
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      respondError(null, -32700, 'Parse error');
      continue;
    }

    const { id: rawId, method } = request;
    const id = rawId ?? null;
    const params = request.params ?? {};

    try {
      switch (method) {
        case 'initialize': {
          const upstream = await getClient();
          respond(id, {
            protocolVersion: upstream.negotiatedProtocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'fmcp', version: packageVersion() },
          });
          break;
        }
        case 'notifications/initialized':
        case 'initialized':
          break;
        case 'ping':
          respond(id, {});
          break;
        case 'tools/list': {
          const upstream = await getClient();
          const tools = await upstream.listTools();
          respond(id, { tools });
          break;
        }
        case 'tools/call': {
          const upstream = await getClient();
          const name = String(params.name ?? '');
          const args = (params.arguments as Record<string, unknown>) ?? {};
          if (!name) {
            respondError(id, -32602, 'missing tool name');
            break;
          }
          const result = await upstream.callTool(name, args);
          respond(id, result);
          break;
        }
        case 'resources/list': {
          const upstream = await getClient();
          respond(id, { resources: await upstream.listResources() });
          break;
        }
        case 'prompts/list': {
          const upstream = await getClient();
          respond(id, { prompts: await upstream.listPrompts() });
          break;
        }
        case 'logging/setLevel':
          respond(id, {});
          break;
        default: {
          if (id === undefined || id === null) break;
          respondError(id, -32601, `Method not found: ${method}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostic(`error handling ${method}: ${message}`);
      if (id === undefined || id === null) continue;
      respondError(id, -32000, message);
    }
  }

  await client?.close();
}
