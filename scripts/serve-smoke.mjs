/**
 * Smoke test for `figma-mcp serve` (stdio MCP bridge).
 *
 * Spawns the bridge, runs an initialize handshake, then tools/list and a
 * tools/call against the real Figma MCP server.
 *
 *   node scripts/serve-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');

const child = spawn(process.execPath, [cli, 'serve'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => process.stderr.write(`[bridge] ${chunk}`));

let buffer = '';
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 120_000);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return promise;
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

let failed = false;
try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'serve-smoke', version: '1.0.0' },
  });
  console.log('initialize ->', JSON.stringify(init.result));
  notify('notifications/initialized', {});

  const tools = await request('tools/list', {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  console.log(`tools/list -> ${names.length} tools`);
  if (names.length === 0) throw new Error('no tools returned');

  const call = await request('tools/call', { name: 'whoami', arguments: {} });
  const text = (call.result?.content ?? []).map((c) => c.text ?? '').join('\n');
  console.log('tools/call whoami ->', text.slice(0, 160));
  if (!text.includes('email')) throw new Error('unexpected whoami payload');

  console.log('\nSERVE SMOKE TEST: OK');
} catch (err) {
  failed = true;
  console.error('\nSERVE SMOKE TEST: FAILED —', err.message);
} finally {
  child.stdin.end();
  child.kill();
}

process.exit(failed ? 1 : 0);
