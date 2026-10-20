import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteToPostgres } from './migrate-sqlite-to-postgres.js';
import { migrateStorage } from './migrations.js';
import { PostgresRingTokenStore } from './ring-token-store-postgres.js';
import { openStorage } from './storage.js';

test('versioned storage migration and durable token-store operations use parameterized SQL', async () => {
  const previousPath = process.env.NEST_DB_PATH;
  const previousUrl = process.env.DATABASE_URL;
  const previousVercel = process.env.VERCEL;
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
  process.env.NEST_DB_PATH = ':memory:';
  const db = await openStorage();
  try {
    await migrateStorage(db);
    await migrateStorage(db);
    const key = Buffer.alloc(32, 9);
    const store = new PostgresRingTokenStore(db, key);
    await store.save('ava1.ring.account.storage-test', { accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 3600000 });
    const stored = await store.get('ava1.ring.account.storage-test');
    assert.equal(stored?.accessToken, 'private-access');
    assert.equal(stored?.refreshToken, 'private-refresh');
    const raw = await db.prepare('SELECT * FROM ring_oauth_tokens').get();
    assert.equal(JSON.stringify(raw).includes('private-access'), false);
    assert.equal(JSON.stringify(raw).includes('private-refresh'), false);
    assert.deepEqual(await store.getStatus(), { linked: true, state: 'connected', expiresAt: stored?.expiresAt });
    await store.save('ava1.ring.account.rotation-test', { accessToken: 'expired-access', refreshToken: 'before-rotation', expiresAt: Date.now() - 1 });
    let refreshCalls = 0;
    const fresh = await store.getFreshAccessToken('ava1.ring.account.rotation-test', async refreshToken => {
      refreshCalls++;
      assert.equal(refreshToken, 'before-rotation');
      return { accessToken: 'after-access', refreshToken: 'after-rotation', expiresAt: Date.now() + 3600000 };
    });
    assert.equal(fresh, 'after-access');
    assert.equal(refreshCalls, 1);
    assert.equal((await store.get('ava1.ring.account.rotation-test'))?.refreshToken, 'after-rotation');
    await store.save('ava1.ring.account.lease-test', { accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 0 });
    assert.equal(await store.claimRefresh('ava1.ring.account.lease-test', 'worker-one'), true);
    assert.equal(await store.claimRefresh('ava1.ring.account.lease-test', 'worker-two'), false);
    const leased = await store.get('ava1.ring.account.lease-test');
    assert.equal(await store.saveRotated('ava1.ring.account.lease-test', leased!.version, 'worker-two', { accessToken: 'stale', refreshToken: 'stale-refresh', expiresAt: Date.now() + 1000 }), false);
    assert.equal(await store.saveRotated('ava1.ring.account.lease-test', leased!.version, 'worker-one', { accessToken: 'new', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600000 }), true);
    const revoked = 'ava1.ring.account.revoked-test';
    await store.save(revoked, { accessToken: 'expired', refreshToken: 'revoked-refresh', expiresAt: Date.now() - 1 });
    await assert.rejects(store.getFreshAccessToken(revoked, async () => {
      const { refreshRingTokens, RingOAuthError } = await import('./ring-auth.js');
      return refreshRingTokens('revoked-refresh', 'id', 'secret', async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    }), error => error instanceof Error && error.message.includes('Re-link'));
    assert.equal((await store.get(revoked))?.state, 'reauthorization_required');
    assert.equal(await store.unlink('ava1.ring.account.storage-test'), true);
    assert.equal(await store.get('ava1.ring.account.storage-test'), null);
  } finally {
    await db.close();
    if (previousPath === undefined) delete process.env.NEST_DB_PATH; else process.env.NEST_DB_PATH = previousPath;
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
  }
});

test('production storage refuses to fall back to ephemeral SQLite', async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousVercel = process.env.VERCEL;
  delete process.env.DATABASE_URL;
  process.env.VERCEL = '1';
  try {
    await assert.rejects(openStorage(), /DATABASE_URL is required on Vercel/);
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
  }
});

test('local data migration copies records without changing the original SQLite file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nest-migrate-'));
  const sourcePath = join(dir, 'source.sqlite');
  const source = new DatabaseSync(sourcePath);
  source.exec("CREATE TABLE people(id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_mode TEXT NOT NULL,text_scale REAL NOT NULL,dementia_mode INTEGER NOT NULL); INSERT INTO people VALUES('sample','Sample Person','visual',1,0)");
  source.close();
  const previousPath = process.env.NEST_DB_PATH;
  const previousUrl = process.env.DATABASE_URL;
  const previousVercel = process.env.VERCEL;
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
  process.env.NEST_DB_PATH = ':memory:';
  const target = await openStorage();
  try {
    const counts = await migrateSqliteToPostgres(sourcePath, target);
    assert.equal(counts.people, 1);
    assert.equal((await target.prepare('SELECT name FROM people WHERE id=?').get('sample')).name, 'Sample Person');
    const verify = new DatabaseSync(sourcePath, { readOnly: true });
    assert.equal(verify.prepare('SELECT count(*) AS n FROM people').get()?.n, 1);
    verify.close();
  } finally {
    await target.close();
    if (previousPath === undefined) delete process.env.NEST_DB_PATH; else process.env.NEST_DB_PATH = previousPath;
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = previousVercel;
    rmSync(dir, { recursive: true, force: true });
  }
});
