import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { exchangeRingAuthorizationCode, parseRingEncryptionKey, refreshRingTokens, ringAccountNonce, RingOAuthError, RingTokenStore, safeStringEqual, verifyRingWebhookSignature } from './ring-auth.js';

const key = Buffer.alloc(32, 7);
const response = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const storeWithExpiredTokens = () => {
  const db = new DatabaseSync(':memory:');
  const store = new RingTokenStore(db, key);
  store.save('ring-account-123', { accessToken: 'old-access-secret', refreshToken: 'old-refresh-secret', expiresAt: Date.now() - 1000 });
  return { db, store };
};

test('encryption keys must be base64 encoded 32-byte values', () => {
  assert.equal(parseRingEncryptionKey(key.toString('base64')).length, 32);
  assert.throws(() => parseRingEncryptionKey('not-a-key'));
  assert.throws(() => parseRingEncryptionKey(undefined));
});

test('one-way account nonce uses HMAC-SHA256 URL-safe base64 without padding', () => {
  const nonce = ringAccountNonce('1792533345000', 'ava1.ring.account.test', 'hmac-key');
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(ringAccountNonce('1792533345000', 'ava1.ring.account.test', 'hmac-key'), nonce);
  assert.notEqual(ringAccountNonce('1792533345001', 'ava1.ring.account.test', 'hmac-key'), nonce);
  assert.equal(safeStringEqual(nonce, nonce), true);
  assert.equal(safeStringEqual(nonce, `${nonce}x`), false);
});

test('webhook signature validates raw bytes and rejects malformed signatures', () => {
  const body = Buffer.from('{ "meta": {"request_id":"one"} }');
  const signature = `sha256=${createHmac('sha256', 'hmac-key').update(body).digest('hex')}`;
  assert.equal(verifyRingWebhookSignature(body, signature, 'hmac-key'), true);
  assert.equal(verifyRingWebhookSignature(Buffer.from('{}'), signature, 'hmac-key'), false);
  assert.equal(verifyRingWebhookSignature(body, 'bad', 'hmac-key'), false);
});

test('authorization code exchange uses Ring endpoint and documented grant fields', async () => {
  let seenUrl = '';
  let seenBody = new URLSearchParams();
  const tokens = await exchangeRingAuthorizationCode('one-time-code', 'client-id', 'client-secret', 'pkce-verifier', async (url, init) => {
    seenUrl = String(url);
    seenBody = new URLSearchParams(String(init?.body));
    return response(200, { access_token: 'access', refresh_token: 'refresh', expires_in: 14400 });
  });
  assert.equal(seenUrl, 'https://oauth.ring.com/oauth/token');
  assert.deepEqual(Object.fromEntries(seenBody), { grant_type: 'authorization_code', client_id: 'client-id', code: 'one-time-code', client_secret: 'client-secret', code_verifier: 'pkce-verifier' });
  assert.equal(tokens.accessToken, 'access');
  assert.equal(tokens.refreshToken, 'refresh');
  assert.ok(tokens.expiresAt > Date.now());
});

test('refresh sends the documented grant and accepts a rotated refresh token', async () => {
  let seenBody = new URLSearchParams();
  const tokens = await refreshRingTokens('previous-refresh', 'client-id', 'client-secret', async (_url, init) => {
    seenBody = new URLSearchParams(String(init?.body));
    return response(200, { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 14400 });
  });
  assert.deepEqual(Object.fromEntries(seenBody), { grant_type: 'refresh_token', refresh_token: 'previous-refresh', client_id: 'client-id', client_secret: 'client-secret' });
  assert.equal(tokens.refreshToken, 'rotated-refresh');
});

test('encrypted SQLite storage hides account and tokens and unlinks by account id', () => {
  const { db, store } = storeWithExpiredTokens();
  const raw = db.prepare('SELECT * FROM ring_oauth_tokens').get() as any;
  const serialized = JSON.stringify(raw);
  assert.equal(serialized.includes('ring-account-123'), false);
  assert.equal(serialized.includes('old-access-secret'), false);
  assert.equal(serialized.includes('old-refresh-secret'), false);
  assert.equal(store.get('ring-account-123')?.refreshToken, 'old-refresh-secret');
  assert.equal(store.unlink('ring-account-123'), true);
  assert.equal(store.get('ring-account-123'), null);
  db.close();
});

test('Ring tokens remain unavailable to API callers until the account nonce is claimed', () => {
  const db = new DatabaseSync(':memory:');
  const store = new RingTokenStore(db, key);
  store.saveUnclaimed('ring-account-123', { accessToken: 'pending-access', refreshToken: 'pending-refresh', expiresAt: Date.now() + 3600000 });
  assert.equal(store.getFirst(), null);
  assert.equal(store.getStatus().linked, false);
  assert.equal(store.unclaimedAccounts()[0]?.refreshToken, 'pending-refresh');
  store.markLinked('ring-account-123');
  assert.equal(store.getFirst()?.accountId, 'ring-account-123');
  assert.equal(store.getStatus().linked, true);
  db.close();
});

test('expired token is refreshed and rotated tokens are atomically persisted', async () => {
  const { db, store } = storeWithExpiredTokens();
  const token = await store.getFreshAccessToken('ring-account-123', async refreshToken => {
    assert.equal(refreshToken, 'old-refresh-secret');
    return { accessToken: 'new-access-secret', refreshToken: 'new-refresh-secret', expiresAt: Date.now() + 3600000 };
  });
  const saved = store.get('ring-account-123');
  assert.equal(token, 'new-access-secret');
  assert.equal(saved?.refreshToken, 'new-refresh-secret');
  assert.equal(saved?.version, 2);
  assert.equal(saved?.state, 'connected');
  db.close();
});

test('simultaneous refresh callers share one refresh and do not lose rotation', async () => {
  const { db, store } = storeWithExpiredTokens();
  let count = 0;
  const refresh = async (_refreshToken: string) => {
    count += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { accessToken: 'single-access', refreshToken: 'single-rotated-refresh', expiresAt: Date.now() + 3600000 };
  };
  const results = await Promise.all([
    store.getFreshAccessToken('ring-account-123', refresh),
    store.getFreshAccessToken('ring-account-123', refresh)
  ]);
  assert.deepEqual(results, ['single-access', 'single-access']);
  assert.equal(count, 1);
  assert.equal(store.get('ring-account-123')?.refreshToken, 'single-rotated-refresh');
  db.close();
});

test('invalid credentials produce a sanitized refresh failure', async () => {
  await assert.rejects(
    refreshRingTokens('refresh-secret', 'client-id', 'client-secret', async () => response(401, { error: 'invalid_client', error_description: 'client-secret must not appear' })),
    (error: RingOAuthError) => error.state === 'refresh_failed' && !error.message.includes('client-secret')
  );
});

test('invalid OAuth client credentials produce a sanitized exchange failure', async () => {
  await assert.rejects(
    exchangeRingAuthorizationCode('one-time-code', 'client-id', 'client-secret', undefined, async () => response(401, { error: 'invalid_client', error_description: 'client-secret must not appear' })),
    (error: RingOAuthError) => error.state === 'refresh_failed' && !error.message.includes('one-time-code') && !error.message.includes('client-secret')
  );
});

test('revoked refresh grant requires reauthorization and marks the stored link', async () => {
  const { db, store } = storeWithExpiredTokens();
  await assert.rejects(store.getFreshAccessToken('ring-account-123', async () => {
    return refreshRingTokens('old-refresh-secret', 'client-id', 'client-secret', async () => response(400, { error: 'invalid_grant' }));
  }), (error: RingOAuthError) => error.state === 'reauthorization_required' && !error.message.includes('old-refresh-secret'));
  assert.equal(store.get('ring-account-123')?.state, 'reauthorization_required');
  db.close();
});
