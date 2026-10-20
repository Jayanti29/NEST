import { createHmac, randomUUID } from 'node:crypto';
import { decryptRingValue, encryptRingValue, RingOAuthError, type RingTokens, type StoredRingTokens, type RingTokenState } from './ring-auth.js';
import type { Storage } from './storage.js';

const activeRefreshes = new Map<string, Promise<string>>();

/** Durable PostgreSQL token store. Lease ownership and version checks are database-atomic. */
export class PostgresRingTokenStore {
  constructor(private readonly db: Storage, private readonly key: Buffer) {}

  accountKey(accountId: string) { return createHmac('sha256', this.key).update(accountId).digest('hex'); }
  private record(row: any): StoredRingTokens | null {
    if (!row) return null;
    return {
      accountId: decryptRingValue(this.key, 'account', row.account_id_enc),
      accessToken: decryptRingValue(this.key, 'access', row.access_token_enc),
      refreshToken: decryptRingValue(this.key, 'refresh', row.refresh_token_enc),
      expiresAt: Number(row.expires_at), version: Number(row.version), state: row.state, linkState: row.link_state
    };
  }
  private async byKey(accountKey: string) { return this.record(await this.db.prepare('SELECT * FROM ring_oauth_tokens WHERE account_key=?').get(accountKey)); }
  async get(accountId: string) { return this.byKey(this.accountKey(accountId)); }
  async getByKey(accountKey: string) { return this.byKey(accountKey); }
  async getFirst() {
    const row = await this.db.prepare("SELECT account_key FROM ring_oauth_tokens WHERE state!='reauthorization_required' AND link_state='linked' ORDER BY updated_at DESC,account_key DESC LIMIT 1").get();
    return row ? this.byKey(String(row.account_key)) : null;
  }
  async getStatus(): Promise<{ linked: boolean; state: RingTokenState | 'authorization_required'; expiresAt: number | null }> {
    const row = await this.db.prepare("SELECT state,link_state,expires_at FROM ring_oauth_tokens ORDER BY CASE WHEN link_state='linked' THEN 0 ELSE 1 END,updated_at DESC,account_key DESC LIMIT 1").get();
    if (!row) return { linked: false, state: 'authorization_required', expiresAt: null };
    return { linked: row.link_state === 'linked' && row.state !== 'reauthorization_required', state: row.state, expiresAt: Number(row.expires_at) };
  }
  async save(accountId: string, tokens: RingTokens) { return this.write(accountId, tokens, 'linked'); }
  async saveUnclaimed(accountId: string, tokens: RingTokens) { return this.write(accountId, tokens, 'unclaimed'); }
  private async write(accountId: string, tokens: RingTokens, linkState: 'linked' | 'unclaimed') {
    const now = Date.now();
    return this.db.prepare(`INSERT INTO ring_oauth_tokens(account_key,account_id_enc,access_token_enc,refresh_token_enc,expires_at,state,link_state,version,refresh_owner,refresh_lease_until,updated_at)
      VALUES(?,?,?,?,?,'connected',?,1,NULL,NULL,?) ON CONFLICT(account_key) DO UPDATE SET account_id_enc=excluded.account_id_enc,
      access_token_enc=excluded.access_token_enc,refresh_token_enc=excluded.refresh_token_enc,expires_at=excluded.expires_at,state='connected',
      link_state=excluded.link_state,version=ring_oauth_tokens.version+1,refresh_owner=NULL,refresh_lease_until=NULL,updated_at=excluded.updated_at`)
      .run(this.accountKey(accountId), encryptRingValue(this.key, 'account', accountId), encryptRingValue(this.key, 'access', tokens.accessToken), encryptRingValue(this.key, 'refresh', tokens.refreshToken), tokens.expiresAt, linkState, now);
  }
  async unclaimedAccounts(): Promise<StoredRingTokens[]> {
    const rows = await this.db.prepare("SELECT account_key FROM ring_oauth_tokens WHERE link_state='unclaimed' AND state='connected'").all();
    return (await Promise.all(rows.map(row => this.byKey(String(row.account_key))))).filter((row): row is StoredRingTokens => Boolean(row));
  }
  async markLinked(accountId: string) {
    return this.db.prepare("UPDATE ring_oauth_tokens SET link_state='linked',updated_at=? WHERE account_key=? AND link_state='unclaimed'").run(Date.now(), this.accountKey(accountId));
  }
  async markReauthorizationRequired(accountId: string) {
    return this.db.prepare("UPDATE ring_oauth_tokens SET state='reauthorization_required',expires_at=0,refresh_owner=NULL,refresh_lease_until=NULL,updated_at=? WHERE account_key=?").run(Date.now(), this.accountKey(accountId));
  }
  async expireNow(accountId: string) { return this.db.prepare('UPDATE ring_oauth_tokens SET expires_at=0 WHERE account_key=?').run(this.accountKey(accountId)); }
  async unlink(accountId: string) {
    return (await this.db.prepare('DELETE FROM ring_oauth_tokens WHERE account_key=?').run(this.accountKey(accountId))).changes === 1;
  }
  async claimRefresh(accountId: string, owner: string, now = Date.now()) {
    const result = await this.db.prepare(`UPDATE ring_oauth_tokens SET refresh_owner=?,refresh_lease_until=? WHERE account_key=? AND (refresh_lease_until IS NULL OR refresh_lease_until<?)`)
      .run(owner, now + 30000, this.accountKey(accountId), now);
    return result.changes === 1;
  }
  async saveRotated(accountId: string, expectedVersion: number, owner: string, tokens: RingTokens) {
    const result = await this.db.prepare(`UPDATE ring_oauth_tokens SET access_token_enc=?,refresh_token_enc=?,expires_at=?,state='connected',version=version+1,refresh_owner=NULL,refresh_lease_until=NULL,updated_at=?
      WHERE account_key=? AND version=? AND refresh_owner=?`)
      .run(encryptRingValue(this.key, 'access', tokens.accessToken), encryptRingValue(this.key, 'refresh', tokens.refreshToken), tokens.expiresAt, Date.now(), this.accountKey(accountId), expectedVersion, owner);
    return result.changes === 1;
  }
  private async release(accountId: string, owner: string, state: RingTokenState) {
    await this.db.prepare('UPDATE ring_oauth_tokens SET state=?,refresh_owner=NULL,refresh_lease_until=NULL,updated_at=? WHERE account_key=? AND refresh_owner=?')
      .run(state, Date.now(), this.accountKey(accountId), owner);
  }
  async getFreshAccessToken(accountId: string, refresh: (refreshToken: string) => Promise<RingTokens>, now = Date.now()): Promise<string> {
    const accountKey = this.accountKey(accountId);
    const current = await this.byKey(accountKey);
    if (!current) throw new RingOAuthError(404, 'reauthorization_required', 'No Ring account is linked. Authorize Ring to continue.');
    if (current.state === 'reauthorization_required') throw new RingOAuthError(401, 'reauthorization_required', 'Ring authorization is no longer valid. Re-link the Ring account.');
    if (current.expiresAt > now + 60000) return current.accessToken;
    const running = activeRefreshes.get(accountKey);
    if (running) return running;
    const task = this.refreshWithLease(accountId, refresh, now);
    activeRefreshes.set(accountKey, task);
    try { return await task; } finally { if (activeRefreshes.get(accountKey) === task) activeRefreshes.delete(accountKey); }
  }
  private async refreshWithLease(accountId: string, refresh: (refreshToken: string) => Promise<RingTokens>, now: number): Promise<string> {
    const accountKey = this.accountKey(accountId);
    const owner = randomUUID();
    const deadline = Date.now() + 35000;
    while (!(await this.claimRefresh(accountId, owner, Date.now()))) {
      const row = await this.byKey(accountKey);
      if (!row) throw new RingOAuthError(404, 'reauthorization_required', 'No Ring account is linked. Authorize Ring to continue.');
      if (row.state === 'reauthorization_required') throw new RingOAuthError(401, row.state, 'Ring authorization is no longer valid. Re-link the Ring account.');
      if (row.expiresAt > now + 60000) return row.accessToken;
      if (Date.now() >= deadline) throw new RingOAuthError(503, 'refresh_failed', 'Ring token refresh is already in progress. Try again shortly.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const row = await this.byKey(accountKey);
    if (!row) { await this.release(accountId, owner, 'reauthorization_required'); throw new RingOAuthError(404, 'reauthorization_required', 'No Ring account is linked. Authorize Ring to continue.'); }
    try {
      const rotated = await refresh(row.refreshToken);
      if (!(await this.saveRotated(accountId, row.version, owner, rotated))) {
        const newer = await this.byKey(accountKey);
        if (newer && newer.expiresAt > now) return newer.accessToken;
        throw new RingOAuthError(409, 'refresh_failed', 'Ring token state changed during refresh. Try again.');
      }
      return rotated.accessToken;
    } catch (error: any) {
      await this.release(accountId, owner, error instanceof RingOAuthError ? error.state : 'refresh_failed');
      throw error instanceof RingOAuthError ? error : new RingOAuthError(502, 'refresh_failed', 'Unable to refresh Ring authorization.');
    }
  }
}
