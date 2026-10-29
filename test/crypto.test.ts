import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectSecret, unprotectSecret } from '../src/util/crypto.js';

const PLAINTEXT = 'fmcp-令牌-🔐-测试-secret';
const KEY_MATERIAL = 'test-key-material';

test('protectSecret/unprotectSecret round-trips a non-ASCII secret', async () => {
  const protectedResult = await protectSecret(PLAINTEXT, KEY_MATERIAL);

  assert.equal(protectedResult.method, process.platform === 'win32' ? 'dpapi' : 'aes');
  assert.notEqual(protectedResult.data, PLAINTEXT);

  const decrypted = await unprotectSecret(protectedResult, KEY_MATERIAL);
  assert.equal(decrypted, PLAINTEXT);
});
