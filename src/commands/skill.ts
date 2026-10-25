import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../util/logger.js';
import { fetchCatalog, type SkillEntry } from '../skills/catalog.js';
import {
  CLIENTS,
  installSkill,
  listInstalled,
  loadManifest,
  removeSkill,
  resolveClient,
  type ClientTarget,
} from '../skills/install.js';

export interface SkillOptions {
  json?: boolean;
  /** Filter: official | community */
  source?: string;
  /** Target client id. */
  client?: string;
  /** Explicit target directory. */
  dir?: string;
  /** user (default) | project */
  scope?: string;
  force?: boolean;
  /** Search term. */
  filter?: string;
  /** Bypass the local catalog cache. */
  refresh?: boolean;
}

export async function skillCommand(
  action: string | undefined,
  args: string[],
  options: SkillOptions = {},
): Promise<void> {
  switch (action) {
    case undefined:
    case 'list':
    case 'ls':
      return listSkills(options);
    case 'install':
    case 'add':
      return installCommand(args, options);
    case 'remove':
    case 'rm':
    case 'uninstall':
      return removeCommand(args, options);
    case 'installed':
      return installedCommand(options);
    case 'path':
      return pathCommand(options);
    default:
      throw new Error(`未知子命令: ${action}（可用: list / install / remove / installed / path）`);
  }
}

async function listSkills(options: SkillOptions): Promise<void> {
  const catalog = await fetchCatalog({ refresh: options.refresh });
  const target = resolveTarget(options);

  let entries = catalog;
  if (options.source) {
    const wanted = options.source.toLowerCase();
    entries = entries.filter((e) => e.source === wanted);
  }
  if (options.filter) {
    const needle = options.filter.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        (e.description ?? '').toLowerCase().includes(needle) ||
        (e.tools ?? []).some((t) => t.toLowerCase().includes(needle)),
    );
  }

  const installed = new Set(listInstalled(target));

  if (options.json) {
    log.out(
      JSON.stringify(
        {
          target: target.dir,
          skills: entries.map((e) => ({ ...e, installed: installed.has(e.name) })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const official = entries.filter((e) => e.source === 'official');
  const community = entries.filter((e) => e.source === 'community');

  log.out(`可安装的 skill（目标目录: ${target.dir}）\n`);

  if (official.length) {
    log.out('官方 (figma/mcp-server-guide):');
    for (const entry of official) {
      log.out(`  ${mark(installed.has(entry.name))} ${entry.name}`);
    }
    log.out('');
  }

  if (community.length) {
    log.out('社区 (figma/community-resources):');
    for (const entry of community) {
      log.out(`  ${mark(installed.has(entry.name))} ${entry.name}`);
      if (entry.description) log.out(`      ${entry.description}`);
      if (entry.tools?.length) log.out(`      tools: ${entry.tools.join(', ')}`);
    }
    log.out('');
  }

  log.out(`安装: fmcp skill install <名称> [--client claude|codex|cursor|fmcp]`);
}

async function installCommand(args: string[], options: SkillOptions): Promise<void> {
  const names = args.filter((a) => !a.startsWith('-'));
  if (names.length === 0) {
    throw new Error('用法: fmcp skill install <skill名> [--client ...] [--force]');
  }

  const catalog = await fetchCatalog({ refresh: options.refresh });
  const target = resolveTarget(options);

  const installed: string[] = [];
  for (const name of names) {
    const entry = findSkill(catalog, name);
    if (!entry) {
      throw new Error(`找不到 skill "${name}"，用 fmcp skill list 查看可安装列表`);
    }
    const result = await installSkill(entry, target, { force: options.force });
    log.out(
      `已安装 ${result.name} -> ${result.target}（${result.files} 个文件）` +
        `${result.updated ? ' [覆盖]' : ''}`,
    );
    installed.push(result.name);
  }

  if (installed.length && options.json) {
    log.out(JSON.stringify({ installed, target: target.dir }, null, 2));
  }
}

async function removeCommand(args: string[], options: SkillOptions): Promise<void> {
  const names = args.filter((a) => !a.startsWith('-'));
  if (names.length === 0) {
    throw new Error('用法: fmcp skill remove <skill名> [--client ...]');
  }
  const target = resolveTarget(options);

  for (const name of names) {
    const removed = removeSkill(name, target);
    log.out(removed ? `已卸载 ${name}（${target.dir}）` : `${name} 未安装在 ${target.dir}`);
  }
}

function installedCommand(options: SkillOptions): void {
  const target = resolveTarget(options);
  const installed = listInstalled(target);
  const manifest = loadManifest();

  if (options.json) {
    log.out(
      JSON.stringify(
        {
          target: target.dir,
          skills: installed.map((name) => ({
            name,
            ...(manifest.installed[target.id]?.[name] ?? {}),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  log.out(`已安装的 skill（${target.dir}）:`);
  if (installed.length === 0) {
    log.out('  （无）');
    return;
  }
  for (const name of installed) {
    const meta = manifest.installed[target.id]?.[name];
    log.out(`  ${name}${meta?.source ? ` (${meta.source})` : ''}`);
  }
}

function pathCommand(options: SkillOptions): void {
  const target = resolveTarget(options);
  log.out(target.dir);
}

function resolveTarget(options: SkillOptions): ClientTarget {
  if (options.dir) {
    return { id: 'custom', label: '自定义目录', dir: options.dir };
  }
  return resolveClient(options.client, options.scope);
}

function findSkill(catalog: SkillEntry[], name: string): SkillEntry | undefined {
  const exact = catalog.find((e) => e.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return catalog.find((e) => e.name.toLowerCase() === lower);
}

function mark(installed: boolean): string {
  return installed ? '[已装]' : '[    ]';
}

/** Skills installed in any known client directory (used to auto-fill skillNames). */
export function installedSkillNames(): string[] {
  const names = new Set<string>();
  for (const target of Object.values(CLIENTS)) {
    if (!existsSync(target.dir)) continue;
    for (const name of listInstalled(target)) names.add(name);
  }
  return [...names];
}

/** Where a skill was installed, if anywhere. */
export function skillInstallPath(name: string): string | undefined {
  for (const target of Object.values(CLIENTS)) {
    const candidate = join(target.dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
