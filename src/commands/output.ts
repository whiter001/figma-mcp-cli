import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult, ToolContent } from '../mcp/client.js';

export interface RenderOptions {
  /** Print the raw JSON-RPC result instead of rendered text. */
  json?: boolean;
  /** Directory where image/blob content is written. */
  saveMedia?: string;
}

/** Render an MCP tool result for the terminal. */
export async function renderToolResult(result: CallToolResult, options: RenderOptions = {}): Promise<string> {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }

  const chunks: string[] = [];

  for (const item of result.content ?? []) {
    chunks.push(await renderContent(item, options));
  }

  if (result.structuredContent !== undefined && !result.content?.length) {
    chunks.push(JSON.stringify(result.structuredContent, null, 2));
  }

  if (result.isError) {
    chunks.push('[工具返回了错误]');
  }

  return chunks.join('\n');
}

async function renderContent(item: ToolContent, options: RenderOptions): Promise<string> {
  switch (item.type) {
    case 'text':
      return renderText(item.text, options);
    case 'image':
      return saveBlob(Buffer.from(item.data, 'base64'), item.mimeType, 'image', options);
    case 'resource': {
      const res = item.resource;
      if (res.text) return renderText(res.text, options);
      if (res.blob) {
        return saveBlob(
          Buffer.from(res.blob, 'base64'),
          res.mimeType ?? 'application/octet-stream',
          'resource',
          options,
        );
      }
      return `[resource ${res.uri ?? ''}]`;
    }
    case 'resource_link':
      return `[resource_link] ${item.uri}${item.name ? ` (${item.name})` : ''}`;
    default:
      return JSON.stringify(item);
  }
}

/**
 * Some Figma tools (e.g. get_screenshot) answer with a hosted asset URL
 * instead of inline base64. When --save-media is given, pull the file down.
 */
async function renderText(text: string, options: RenderOptions): Promise<string> {
  if (!options.saveMedia) return text;

  const imageUrl = extractImageUrl(text);
  if (!imageUrl) return text;

  return `${text}\n${await downloadTo(imageUrl, options.saveMedia)}`;
}

function extractImageUrl(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const json = JSON.parse(trimmed) as { image_url?: unknown };
    return typeof json.image_url === 'string' ? json.image_url : undefined;
  } catch {
    return undefined;
  }
}

async function downloadTo(url: string, dir: string): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return `[下载截图失败: HTTP ${res.status}]`;
    const buffer = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') ?? 'image/png';
    return saveBlob(buffer, type, 'image', { saveMedia: dir });
  } catch (err) {
    return `[下载截图失败: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

function saveBlob(
  buffer: Buffer,
  mimeType: string,
  prefix: string,
  options: RenderOptions,
): string {
  if (!options.saveMedia) {
    return `[${prefix} ${mimeType}, ${buffer.length} bytes — 使用 --save-media <dir> 保存]`;
  }
  mkdirSync(options.saveMedia, { recursive: true });
  const ext = extensionFor(mimeType);
  const name = `${prefix}-${Date.now()}.${ext}`;
  const path = join(options.saveMedia, name);
  writeFileSync(path, buffer);
  return `[已保存 ${path} (${mimeType}, ${buffer.length} bytes)]`;
}

function extensionFor(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'application/json': 'json',
  };
  return map[mimeType] ?? 'bin';
}
