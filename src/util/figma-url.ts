/**
 * Helpers for turning "what the user pasted" into what the Figma MCP server wants.
 *
 * The remote server resolves a node by its node id, e.g. `1:23` or `1-23`.
 * Users usually paste a Figma URL such as:
 *   https://www.figma.com/design/<fileKey>/<name>?node-id=1-23&t=abc
 * so we extract the node id from the `node-id` query parameter.
 */
export interface FigmaTarget {
  /** Normalized node id (`1:23`), when one could be determined. */
  nodeId?: string;
  /** The original input, forwarded verbatim when no node id could be parsed. */
  raw: string;
  /** The file key, when the input was a Figma URL. */
  fileKey?: string;
  /** True when the input looked like a Figma URL. */
  isUrl: boolean;
}

const NODE_ID_RE = /(\d+)[-:](\d+)/;

/** Parse a Figma URL or a raw node id into a target. */
export function parseTarget(input: string): FigmaTarget {
  const raw = input.trim();

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { raw, isUrl: true };
    }

    // `node-id` may appear in the query string or in the hash fragment.
    const fromQuery = url.searchParams.get('node-id');
    const fromHash = nodeIdFromHash(url.hash);
    const nodeIdRaw = fromQuery ?? fromHash;
    const nodeId = nodeIdRaw ? normalizeNodeId(nodeIdRaw) : undefined;

    const fileKey = extractFileKey(url);

    return {
      ...(nodeId ? { nodeId } : {}),
      ...(fileKey ? { fileKey } : {}),
      raw,
      isUrl: true,
    };
  }

  // Bare node id, e.g. "1:23" or "1-23".
  if (/^\d+[-:]\d+$/.test(raw)) {
    return { nodeId: normalizeNodeId(raw), raw, isUrl: false };
  }

  return { raw, isUrl: false };
}

/** Figma uses `:` in the API and `-` in URLs; the server accepts both, `:` is canonical. */
export function normalizeNodeId(nodeId: string): string {
  const match = NODE_ID_RE.exec(nodeId);
  if (!match) return nodeId;
  return `${match[1]}:${match[2]}`;
}

/** Read `node-id` from a URL hash, with or without a leading `?`. */
function nodeIdFromHash(hash: string): string | undefined {
  if (!hash) return undefined;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw;
  return new URLSearchParams(query).get('node-id') ?? undefined;
}

function extractFileKey(url: URL): string | undefined {  const segments = url.pathname.split('/').filter(Boolean);
  // /design/<key>/..., /file/<key>/..., /proto/<key>/...
  const known = ['design', 'file', 'proto', 'board', 'slides', 'deck'];
  const idx = known.indexOf(segments[0] ?? '');
  if (idx >= 0 && segments[1]) return segments[1];
  // Fall back to the first path segment that looks like a file key.
  const candidate = segments.find((s) => /^[A-Za-z0-9]{10,}$/.test(s));
  return candidate;
}

/** True when the string looks like a Figma file URL. */
export function isFigmaUrl(input: string): boolean {
  return /^https?:\/\/(www\.)?figma\.com\//i.test(input.trim());
}
