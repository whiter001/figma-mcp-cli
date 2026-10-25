import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, normalizeNodeId } from '../src/util/figma-url.js';

test('parseTarget extracts node id from a Figma design URL', () => {
  const target = parseTarget('https://www.figma.com/design/abc123XYZ/My-File?node-id=1-23&t=abc');
  assert.equal(target.isUrl, true);
  assert.equal(target.nodeId, '1:23');
  assert.equal(target.fileKey, 'abc123XYZ');
});

test('parseTarget extracts node id from the hash fragment', () => {
  const target = parseTarget('https://www.figma.com/file/KEY123/Name#node-id=12-34');
  assert.equal(target.nodeId, '12:34');
});

test('parseTarget handles proto and design file paths', () => {
  assert.equal(parseTarget('https://www.figma.com/proto/KEY123/Name?node-id=5-6').fileKey, 'KEY123');
  assert.equal(parseTarget('https://www.figma.com/design/KEY123/Name?node-id=5-6').fileKey, 'KEY123');
});

test('parseTarget accepts a bare node id', () => {
  const target = parseTarget('1:23');
  assert.equal(target.isUrl, false);
  assert.equal(target.nodeId, '1:23');
  assert.equal(target.nodeId, normalizeNodeId('1-23'));
});

test('parseTarget passes through unknown values untouched', () => {
  const target = parseTarget('some-random-value');
  assert.equal(target.nodeId, undefined);
  assert.equal(target.raw, 'some-random-value');
});
