import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSse } from '../src/mcp/client.js';

test('parseSse extracts JSON-RPC messages from an SSE body', () => {
  const body = [
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}',
    '',
  ].join('\n');

  const messages = parseSse(body);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.id, 1);
  assert.equal(messages[1]?.id, 2);
});

test('parseSse joins multi-line data payloads', () => {
  const body = ['data: {"jsonrpc":"2.0",', 'data: "id":7,"result":{}}', ''].join('\n');
  const messages = parseSse(body);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, 7);
});

test('parseSse ignores malformed frames', () => {
  const body = ['data: not-json', '', 'data: {"jsonrpc":"2.0","id":3,"result":{}}', ''].join('\n');
  const messages = parseSse(body);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, 3);
});
