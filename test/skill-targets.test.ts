import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveClient, CLIENTS } from '../src/skills/install.js';

test('resolveClient maps the cross-client convention', () => {
  assert.equal(resolveClient('agents').dir, join(homedir(), '.agents', 'skills'));
  assert.equal(resolveClient(undefined, 'user').dir, join(homedir(), '.agents', 'skills'));
});

test('resolveClient supports per-tool directories', () => {
  assert.equal(resolveClient('codex').dir, join(homedir(), '.codex', 'skills'));
  assert.equal(resolveClient('claude').dir, join(homedir(), '.claude', 'skills'));
  assert.equal(resolveClient('cursor').dir, join(homedir(), '.cursor', 'skills'));
  assert.equal(resolveClient('fmcp').dir, join(homedir(), '.fmcp', 'skills'));
});

test('resolveClient --scope project targets the working directory', () => {
  assert.equal(resolveClient(undefined, 'project').dir, join(process.cwd(), '.agents', 'skills'));
});

test('resolveClient rejects unknown clients', () => {
  assert.throws(() => resolveClient('nope'), /未知客户端/);
});

test('every known client exposes a skills directory', () => {
  for (const target of Object.values(CLIENTS)) {
    assert.ok(target.dir.endsWith(join('skills')), `${target.id} 应以 skills 结尾`);
  }
});
