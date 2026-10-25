import { readFileSync } from 'node:fs';
import { log } from '../util/logger.js';
import { connect } from './context.js';
import { renderToolResult } from './output.js';
import { parseTarget } from '../util/figma-url.js';

export interface CallOptions {
  json?: boolean;
  saveMedia?: string;
  /** Arguments as a JSON object. */
  args?: string;
  /** Arguments as `key=value` pairs (repeatable). */
  arg?: string[];
  /** Read arguments from a JSON file. */
  file?: string;
  timeoutMs?: number;
}

/** Parse `--arg key=value` pairs; values that look like JSON are parsed as JSON. */
export function parseKeyValueArgs(pairs: string[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index === -1) {
      throw new Error(`--arg 格式应为 key=value，收到: ${pair}`);
    }
    const key = pair.slice(0, index);
    const raw = pair.slice(index + 1);
    result[key] = coerce(raw);
  }
  return result;
}

function coerce(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

export async function call(toolName: string, options: CallOptions = {}): Promise<void> {
  const args: Record<string, unknown> = {};

  if (options.file) {
    const parsed = JSON.parse(readFileSync(options.file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(args, parsed);
    } else {
      throw new Error('--file 必须包含一个 JSON 对象');
    }
  }

  if (options.args) {
    const parsed = JSON.parse(options.args) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(args, parsed);
    } else {
      throw new Error('--args 必须是一个 JSON 对象');
    }
  }

  Object.assign(args, parseKeyValueArgs(options.arg));

  // Convenience: a Figma URL anywhere in the arguments is expanded into
  // nodeId / fileKey, without overriding values the caller set explicitly.
  for (const value of Object.values(args)) {
    if (typeof value !== 'string' || !/^https?:\/\/(www\.)?figma\.com\//i.test(value.trim())) continue;
    const target = parseTarget(value);
    if (target.nodeId && args.nodeId === undefined) args.nodeId = target.nodeId;
    if (target.fileKey && args.fileKey === undefined) args.fileKey = target.fileKey;
  }

  const { client } = await connect({ timeoutMs: options.timeoutMs ?? 180_000 });
  const result = await client.callTool(toolName, args);
  await client.close();

  log.out(await renderToolResult(result, { json: options.json, saveMedia: options.saveMedia }));
}
