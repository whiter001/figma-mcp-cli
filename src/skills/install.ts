import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTarGz } from '../util/tar.js';
import { githubHeaders, tarballUrl, type SkillEntry } from './catalog.js';
import { log } from '../util/logger.js';

export interface ClientTarget {
  id: string;
  label: string;
  dir: string;
}

/** Where each agent keeps its user-level skills. */
export const CLIENTS: Record<string, ClientTarget> = {
  // Cross-client convention — most agents scan this one.
  agents: { id: 'agents', label: '通用目录 (~/.agents/skills)', dir: join(homedir(), '.agents', 'skills') },
  claude: { id: 'claude', label: 'Claude Code', dir: join(homedir(), '.claude', 'skills') },
  codex: { id: 'codex', label: 'Codex', dir: join(homedir(), '.codex', 'skills') },
  cursor: { id: 'cursor', label: 'Cursor', dir: join(homedir(), '.cursor', 'skills') },
  fmcp: { id: 'fmcp', label: 'fmcp 自有目录', dir: join(homedir(), '.fmcp', 'skills') },
};

export interface InstalledSkill {
  source: SkillEntry['source'];
  url: string;
  path: string;
  repo: string;
  installedAt: string;
}

interface Manifest {
  version: 1;
  installed: Record<string, Record<string, InstalledSkill>>;
}

export function manifestPath(): string {
  return join(homedir(), '.fmcp', 'skills.json');
}

export function loadManifest(): Manifest {
  const path = manifestPath();
  if (!existsSync(path)) return { version: 1, installed: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    if (!parsed.installed) parsed.installed = {};
    return parsed;
  } catch {
    return { version: 1, installed: {} };
  }
}

export function saveManifest(manifest: Manifest): void {
  const path = manifestPath();
  mkdirSync(join(homedir(), '.fmcp'), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8');
}

/** Resolve the client to install into: explicit > scope > env > auto-detect > fmcp. */
export function resolveClient(explicit?: string, scope?: string): ClientTarget {
  if (scope === 'project') {
    return { id: 'project', label: '项目级 (.agents/skills)', dir: join(process.cwd(), '.agents', 'skills') };
  }
  if (scope === 'user') {
    return CLIENTS.agents as ClientTarget;
  }

  if (explicit) {
    const target = CLIENTS[explicit.toLowerCase()];
    if (!target) {
      throw new Error(
        `未知客户端 "${explicit}"，可选: ${Object.keys(CLIENTS).join(' / ')}（或用 --dir 指定任意目录）`,
      );
    }
    return target;
  }

  const envDir = process.env.FIGMA_MCP_SKILL_DIR?.trim();
  if (envDir) {
    return { id: 'custom', label: '自定义目录', dir: envDir };
  }

  // ~/.agents/skills is the cross-client convention — prefer it when present.
  for (const id of ['agents', 'codex', 'claude', 'cursor']) {
    const target = CLIENTS[id];
    if (target && existsSync(target.dir)) return target;
  }
  return CLIENTS.agents as ClientTarget;
}

export interface InstallResult {
  name: string;
  target: string;
  files: number;
  updated: boolean;
}

/** Download and install one skill into the target skills directory. */
export async function installSkill(
  entry: SkillEntry,
  target: ClientTarget,
  options: { force?: boolean } = {},
): Promise<InstallResult> {
  const dest = join(target.dir, entry.name);
  if (existsSync(dest) && !options.force) {
    throw new Error(`${entry.name} 已安装在 ${dest}（用 --force 覆盖）`);
  }

  log.info(`下载 ${entry.repo} ...`);
  const tarball = await downloadTarball(entry.repo, entry.branch);

  const tempRoot = mkdtempSync(join(tmpdir(), 'fmcp-skill-'));
  try {
    extractTarGz(tarball, tempRoot);

    const sourceDir = locateSkillDir(tempRoot, entry);
    if (!sourceDir) {
      throw new Error(
        `在 ${entry.repo} 的 ${entry.path || '(根目录)'} 下没找到 SKILL.md，` +
          `可能仓库结构已变化。`,
      );
    }

    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(target.dir, { recursive: true });
    cpSync(sourceDir, dest, {
      recursive: true,
      filter: (src) => !src.includes(`${'.git'}`),
    });

    const files = countFiles(dest);
    const manifest = loadManifest();
    const bucket = (manifest.installed[target.id] ??= {});
    bucket[entry.name] = {
      source: entry.source,
      url: entry.url,
      path: entry.path,
      repo: entry.repo,
      installedAt: new Date().toISOString(),
    };
    saveManifest(manifest);

    return { name: entry.name, target: dest, files, updated: Boolean(options.force) };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function downloadTarball(repo: string, branch?: string): Promise<Buffer> {
  const url = tarballUrl(repo, branch);
  const res = await fetch(url, {
    headers: { 'user-agent': 'fmcp-cli', ...(githubHeaders().authorization ? { authorization: githubHeaders().authorization } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`下载失败 (HTTP ${res.status}): ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Find the folder that holds SKILL.md inside the extracted archive. */
function locateSkillDir(root: string, entry: SkillEntry): string | undefined {
  const repoRoot = readdirSync(root).find((name) => statSync(join(root, name)).isDirectory());
  if (!repoRoot) return undefined;
  const base = join(root, repoRoot);

  const candidates: string[] = [];
  if (entry.path) candidates.push(join(base, entry.path));
  candidates.push(join(base, entry.name));
  candidates.push(base);

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'SKILL.md'))) return candidate;
  }

  // Last resort: search the tree (depth limited) for <name>/SKILL.md.
  const found = searchForSkill(base, entry.name, 3);
  return found;
}

function searchForSkill(dir: string, name: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const item of entries) {
    if (item === '.git' || item === 'node_modules') continue;
    const full = join(dir, item);
    if (!statSync(full).isDirectory()) continue;
    if (item === name && existsSync(join(full, 'SKILL.md'))) return full;
    const found = searchForSkill(full, name, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function countFiles(dir: string): number {
  let total = 0;
  for (const item of readdirSync(dir)) {
    const full = join(dir, item);
    if (statSync(full).isDirectory()) total += countFiles(full);
    else total += 1;
  }
  return total;
}

/** Uninstall a skill from a client directory. */
export function removeSkill(name: string, target: ClientTarget): boolean {
  const dest = join(target.dir, name);
  if (!existsSync(dest)) return false;
  rmSync(dest, { recursive: true, force: true });

  const manifest = loadManifest();
  const bucket = manifest.installed[target.id];
  if (bucket) {
    delete bucket[name];
    saveManifest(manifest);
  }
  return true;
}

/** Skills physically present in a client directory. */
export function listInstalled(target: ClientTarget): string[] {
  if (!existsSync(target.dir)) return [];
  return readdirSync(target.dir)
    .filter((item) => {
      const full = join(target.dir, item);
      return statSync(full).isDirectory() && existsSync(join(full, 'SKILL.md'));
    })
    .sort();
}
