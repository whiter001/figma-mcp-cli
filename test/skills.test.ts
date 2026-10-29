import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTar } from '../src/util/tar.js';
import {
  builtinSkillPath,
  fetchBuiltinSkills,
  parseGitHubUrl,
  parseCommunityIndex,
} from '../src/skills/catalog.js';

function tarHeader(name: string, size: number, typeflag = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('000644 \0', 100, 8, 'utf8');
  header.write('000000 \0', 108, 8, 'utf8');
  header.write('000000 \0', 116, 8, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'utf8');
  header.write('00000000000 ', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write(typeflag, 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  return header;
}

function buildTar(files: { name: string; content: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const data = Buffer.from(file.content, 'utf8');
    blocks.push(tarHeader(file.name, data.length));
    blocks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024)); // end of archive
  return Buffer.concat(blocks);
}

test('readTar reads regular files', () => {
  const tar = buildTar([{ name: 'skills/demo/SKILL.md', content: 'hello' }]);
  const entries = readTar(tar);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type, 'file');
  assert.equal(entries[0]?.name, 'skills/demo/SKILL.md');
  assert.equal(entries[0]?.data.toString('utf8'), 'hello');
});

test('readTar supports the ustar prefix field', () => {
  const header = tarHeader('SKILL.md', 2);
  header.write('skills/demo', 345, 155, 'utf8');
  const tar = Buffer.concat([header, Buffer.from('hi'), Buffer.alloc(510), Buffer.alloc(1024)]);
  const entries = readTar(tar);
  assert.equal(entries[0]?.name, 'skills/demo/SKILL.md');
});

test('parseGitHubUrl handles repo root, tree paths and branch names', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/owner/repo'), {
    repo: 'owner/repo',
    path: '',
  });
  assert.deepEqual(parseGitHubUrl('https://github.com/owner/repo/tree/main/skills/demo'), {
    repo: 'owner/repo',
    branch: 'main',
    path: 'skills/demo',
  });
  assert.equal(parseGitHubUrl('https://example.com/x')?.repo, undefined);
});

test('parseCommunityIndex extracts name, source, tools and description', () => {
  const markdown = [
    '#### demo-skill',
    '',
    '[SOURCE CODE](https://github.com/acme/skills/tree/main/skills/demo) · [MIT](https://github.com/acme/skills/blob/main/LICENSE)',
    '**MCP Tools:** `use_figma` `get_metadata`.',
    'Does a demo thing with the design.',
    '',
  ].join('\n');

  const entries = parseCommunityIndex(markdown);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry?.name, 'demo-skill');
  assert.equal(entry?.source, 'community');
  assert.equal(entry?.repo, 'acme/skills');
  assert.equal(entry?.branch, 'main');
  assert.equal(entry?.path, 'skills/demo');
  assert.deepEqual(entry?.tools, ['use_figma', 'get_metadata']);
  assert.equal(entry?.description, 'Does a demo thing with the design.');
});

test('builtin catalog includes fmcp and resolves its packaged SKILL.md', () => {
  const entry = fetchBuiltinSkills().find((skill) => skill.name === 'fmcp');
  assert.equal(entry?.source, 'builtin');
  assert.equal(entry?.path, 'skills/fmcp');
  assert.ok(builtinSkillPath('fmcp'));
});
