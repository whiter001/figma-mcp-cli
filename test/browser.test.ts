import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildOpenCommand } from '../src/util/browser.js';

const AUTH_URL =
  'https://api.figma.com/v1/oauth/authorize?client_id=abc123&code_challenge=XYZ-9' +
  '&code_challenge_method=S256&redirect_uri=http%3A%2F%2F127.0.0.1%3A53219%2Fcallback' +
  '&response_type=code&scope=figma%3Aread&state=st_9f3a';

test('buildOpenCommand quotes the URL for cmd.exe on win32', () => {
  const spec = buildOpenCommand('win32', AUTH_URL);
  assert.equal(spec.cmd, 'cmd');
  // node's own escaping would rewrite the quotes to \" and cmd would close the
  // quoted section early, making the `&` special again.
  assert.equal(spec.windowsVerbatimArguments, true);
  assert.deepEqual(spec.args, ['/c', 'start', '""', `"${AUTH_URL}"`]);
});

test('buildOpenCommand passes the URL through untouched elsewhere', () => {
  assert.deepEqual(buildOpenCommand('darwin', AUTH_URL), { cmd: 'open', args: [AUTH_URL] });
  assert.deepEqual(buildOpenCommand('linux', AUTH_URL), { cmd: 'xdg-open', args: [AUTH_URL] });
});

test('buildOpenCommand encodes quotes that would break the cmd quoting', () => {
  const spec = buildOpenCommand('win32', 'https://example.com/?q="x"');
  const last = spec.args.at(-1);
  assert.equal(last, '"https://example.com/?q=%22x%22"');
});

test('win32: cmd.exe keeps the whole URL in a single argument', { skip: process.platform !== 'win32' }, () => {
  // cmd re-parses the command line it is given: an unquoted `&` ends the
  // command, so the browser would only receive the part before the first `&`.
  // Echo the token back to prove the URL survives cmd's parsing as one arg.
  const spec = buildOpenCommand('win32', AUTH_URL);
  const quoted = spec.args.at(-1);
  assert.ok(quoted);

  const probe = spawnSync(spec.cmd, ['/c', 'echo', quoted], {
    encoding: 'utf8',
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });

  assert.equal(probe.status, 0);
  assert.equal(probe.stdout.trim(), `"${AUTH_URL}"`);
  // A split would leave the tail of the query string running as commands.
  assert.equal(probe.stderr.trim(), '');
});
