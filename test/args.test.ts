import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeyValueArgs } from '../src/commands/call.js';
import { pkceChallenge, base64url } from '../src/util/crypto.js';
import { createHash } from 'node:crypto';

test('parseKeyValueArgs coerces JSON-ish values', () => {
  const args = parseKeyValueArgs([
    'nodeId=1:23',
    'clientLanguages=typescript',
    'flag=true',
    'count=42',
    'ratio=1.5',
    'nested={"a":1}',
  ]);

  assert.equal(args.nodeId, '1:23');
  assert.equal(args.clientLanguages, 'typescript');
  assert.equal(args.flag, true);
  assert.equal(args.count, 42);
  assert.equal(args.ratio, 1.5);
  assert.deepEqual(args.nested, { a: 1 });
});

test('parseKeyValueArgs rejects malformed pairs', () => {
  assert.throws(() => parseKeyValueArgs(['nope']), /key=value/);
});

test('pkceChallenge is the base64url SHA-256 of the verifier', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expected = base64url(createHash('sha256').update(verifier).digest());
  assert.equal(pkceChallenge(verifier), expected);
  assert.equal(pkceChallenge(verifier).length, 43);
});
