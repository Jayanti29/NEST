import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateRingLinkRequest } from './ring-link.js';

const nonce = '0123456789abcdef0123456789abcdef0123456789a';

test('Ring link callback accepts a well-formed nonce within the ten-minute window', () => {
  assert.equal(validateRingLinkRequest('1792533345000', nonce, 1792533945000), 'valid');
});

test('Ring link callback rejects malformed timestamp and nonce values', () => {
  assert.equal(validateRingLinkRequest('not-a-time', nonce, 1792533345000), 'malformed');
  assert.equal(validateRingLinkRequest('1792533345000', `${nonce}=`, 1792533345000), 'malformed');
});

test('Ring link callback rejects future and expired timestamps', () => {
  assert.equal(validateRingLinkRequest('1792533345001', nonce, 1792533345000), 'expired');
  assert.equal(validateRingLinkRequest('1792533345000', nonce, 1792533945001), 'expired');
});
