import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { log } from '../util/logger.js';

export type SkillSource = 'official' | 'community';

export interface SkillEntry {
  name: string;
  source: SkillSource;
  /** owner/repo on GitHub. */
  repo: string;
  /** Branch to download, undefined = the repository default branch. */
  branch?: string;
  /** Path of the skill folder inside the repository (empty = repository root). */
  path: string;
  /** Human readable page. */
  url: string;
  description?: string;
  /** MCP tools the skill expects to drive. */
  tools?: string[];
  license?: string;
}

const OFFICIAL_REPO = 'figma/mcp-server-guide';
const OFFICIAL_BRANCH = 'main';
const OFFICIAL_SKILLS_PATH = 'skills';

const COMMUNITY_INDEX_URL =
  'https://raw.githubusercontent.com/figma/community-resources/main/agent_skills/README.md';

const GITHUB_API = 'https://api.github.com';

export function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'fmcp-cli',
  };
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch with retry — GitHub's CDN is flaky from some regions. */
async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  attempts = 3,
  timeoutMs = 20_000,
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 500 && attempt < attempts) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(500 * attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        log.debug(`请求 ${url} 失败 (${(err as Error).message})，第 ${attempt} 次重试`);
        await sleep(800 * attempt);
        continue;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** All official Figma skills, straight from the figma/mcp-server-guide repo. */
export async function fetchOfficialSkills(): Promise<SkillEntry[]> {
  const url = `${GITHUB_API}/repos/${OFFICIAL_REPO}/contents/${OFFICIAL_SKILLS_PATH}?ref=${OFFICIAL_BRANCH}`;
  const res = await fetchWithRetry(url, { headers: githubHeaders() });
  if (!res.ok) {
    throw new Error(`无法读取官方 skill 列表 (HTTP ${res.status})`);
  }

  const items = (await res.json()) as { name: string; path: string; type: string }[];
  return items
    .filter((item) => item.type === 'dir')
    .map((item) => ({
      name: item.name,
      source: 'official' as const,
      repo: OFFICIAL_REPO,
      branch: OFFICIAL_BRANCH,
      path: `${OFFICIAL_SKILLS_PATH}/${item.name}`,
      url: `https://github.com/${OFFICIAL_REPO}/tree/${OFFICIAL_BRANCH}/${item.path}`,
    }));
}

/**
 * Community skills, parsed from the figma/community-resources index.
 * The index lists each skill as:
 *
 *   #### <skill-name>
 *   [SOURCE CODE](<url>) · [MIT](<license url>)
 *   **MCP Tools:** `a` `b`.
 *   <description>
 *
 * The GitHub API is used first (raw.githubusercontent.com is unreliable from
 * some regions); the raw URL is only a fallback.
 */
export async function fetchCommunitySkills(): Promise<SkillEntry[]> {
  const viaApi = await fetchCommunityIndexViaApi();
  if (viaApi) return parseCommunityIndex(viaApi);

  const res = await fetchWithRetry(
    COMMUNITY_INDEX_URL,
    { headers: { 'user-agent': 'fmcp-cli' } },
    3,
    25_000,
  );
  if (!res.ok) {
    throw new Error(`无法读取社区 skill 索引 (HTTP ${res.status})`);
  }
  return parseCommunityIndex(await res.text());
}

async function fetchCommunityIndexViaApi(): Promise<string | undefined> {
  const url = `${GITHUB_API}/repos/figma/community-resources/contents/agent_skills/README.md`;
  try {
    const res = await fetchWithRetry(url, { headers: githubHeaders() }, 2, 15_000);
    if (!res.ok) return undefined;
    const json = (await res.json()) as { encoding?: string; content?: string };
    if (json.encoding === 'base64' && json.content) {
      return Buffer.from(json.content.replace(/\n/g, ''), 'base64').toString('utf8');
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function parseCommunityIndex(markdown: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  const blocks = markdown.split(/\n(?=####\s)/);

  for (const block of blocks) {
    const heading = /^####\s+(.+?)\s*$/m.exec(block);
    if (!heading) continue;
    const name = heading[1]?.trim();
    if (!name) continue;

    const sourceMatch = /\[SOURCE CODE\]\(([^)]+)\)/.exec(block);
    if (!sourceMatch?.[1]) continue;
    const sourceUrl = sourceMatch[1];

    const location = parseGitHubUrl(sourceUrl);
    if (!location) continue;

    const licenseMatch = /\[([A-Z0-9][A-Z0-9 .+-]*)\]\([^)]*LICENSE[^)]*\)/i.exec(block);
    const toolsMatch = /\*\*MCP Tools:\*\*\s*(.+)/.exec(block);
    const tools = toolsMatch?.[1]
      ? [...toolsMatch[1].matchAll(/`([^`]+)`/g)].map((m) => m[1] as string)
      : undefined;

    const description = extractDescription(block);

    entries.push({
      name,
      source: 'community',
      repo: location.repo,
      ...(location.branch ? { branch: location.branch } : {}),
      path: location.path,
      url: sourceUrl,
      ...(description ? { description } : {}),
      ...(tools?.length ? { tools } : {}),
      ...(licenseMatch?.[1] ? { license: licenseMatch[1].trim() } : {}),
    });
  }

  return entries;
}

function extractDescription(block: string): string | undefined {
  const lines = block.split('\n');
  const toolsIndex = lines.findIndex((l) => l.includes('**MCP Tools:**'));
  const start = toolsIndex >= 0 ? toolsIndex + 1 : 0;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? '';
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('**')) continue;
    return line.replace(/\s+/g, ' ');
  }
  return undefined;
}

export interface GitHubLocation {
  repo: string;
  branch?: string;
  path: string;
}

/** Parse a GitHub URL into repo / branch / path. */
export function parseGitHubUrl(url: string): GitHubLocation | undefined {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)(?:\/(?:tree|blob)\/([^/?#]+)(?:\/(.*))?)?/.exec(
    url.trim(),
  );
  if (!match) return undefined;

  const owner = match[1] as string;
  const repo = (match[2] as string).replace(/\.git$/, '');
  const branch = match[3];
  const path = (match[4] ?? '').replace(/^\/+|\/+$/g, '');

  return { repo: `${owner}/${repo}`, ...(branch ? { branch } : {}), path };
}

/** Official + community catalog. */
export async function fetchCatalog(options: { refresh?: boolean } = {}): Promise<SkillEntry[]> {
  const cached = readCatalogCache();
  if (cached && !options.refresh) return cached.entries;

  const [official, community] = await Promise.all([
    fetchOfficialSkills().catch((err) => {
      log.warn(`官方 skill 列表获取失败: ${err instanceof Error ? err.message : String(err)}`);
      return [] as SkillEntry[];
    }),
    fetchCommunitySkills().catch((err) => {
      log.warn(`社区 skill 索引获取失败: ${err instanceof Error ? err.message : String(err)}`);
      return [] as SkillEntry[];
    }),
  ]);

  const seen = new Set<string>();
  const entries = [...official, ...community].filter((entry) => {
    const key = `${entry.source}:${entry.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Only cache a complete result — a partial one would hide skills.
  if (official.length && community.length) writeCatalogCache(entries);

  return entries;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface CatalogCache {
  fetchedAt: number;
  entries: SkillEntry[];
}

function cachePath(): string {
  return join(homedir(), '.fmcp', 'cache', 'catalog.json');
}

function readCatalogCache(): CatalogCache | undefined {
  const path = cachePath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CatalogCache;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeCatalogCache(entries: SkillEntry[]): void {
  const path = cachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), entries } satisfies CatalogCache), 'utf8');
  } catch {
    /* cache is best effort */
  }
}

/** Download URL for a repository tarball. */
export function tarballUrl(repo: string, branch?: string): string {
  return branch
    ? `https://codeload.github.com/${repo}/tar.gz/refs/heads/${branch}`
    : `https://codeload.github.com/${repo}/tar.gz/`;
}
