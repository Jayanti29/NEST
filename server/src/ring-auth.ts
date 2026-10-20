import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type RingTokenState = 'connected' | 'refresh_failed' | 'reauthorization_required';
export type RingTokens = { accessToken: string; refreshToken: string; expiresAt: number };
export type StoredRingTokens = RingTokens & { accountId: string; version: number; state: RingTokenState; linkState: 'unclaimed' | 'linked' };

const oauthEndpoint = 'https://oauth.ring.com/oauth/token';
const refreshLeases = new Map<string, Promise<string>>();

export function ringAccountNonce(timestampMs: string, accountId: string, hmacKey: string): string {
  return createHmac('sha256', hmacKey).update(`${timestampMs}:${accountId}`).digest('base64url');
}

export function safeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyRingWebhookSignature(rawBody: Buffer, signature: string, hmacKey: string): boolean {
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = `sha256=${createHmac('sha256', hmacKey).update(rawBody).digest('hex')}`;
  return safeStringEqual(expected.toLowerCase(), signature.toLowerCase());
}

export function parseRingEncryptionKey(encoded: string | undefined): Buffer {
  if (!encoded) throw new Error('Ring token encryption is not configured.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('Ring token encryption key must be a base64 encoded 32-byte key.');
  return key;
}

function encrypt(key: Buffer, purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`nest:ring:${purpose}`));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

function decrypt(key: Buffer, purpose: string, value: string): string {
  const [ivPart, tagPart, ciphertextPart] = value.split('.');
  if (!ivPart || !tagPart || !ciphertextPart) throw new Error('Stored Ring token data is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'));
  decipher.setAAD(Buffer.from(`nest:ring:${purpose}`));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextPart, 'base64url')), decipher.final()]).toString('utf8');
}

export class RingOAuthError extends Error {
  constructor(public readonly status: number, public readonly state: 'refresh_failed' | 'reauthorization_required', message: string) { super(message); }
}

export async function exchangeRingAuthorizationCode(code: string, clientId: string, clientSecret: string, codeVerifier?: string, fetcher: typeof fetch = fetch): Promise<RingTokens> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, client_secret: clientSecret });
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  return requestTokens(body, 'authorization code', fetcher);
}

export async function refreshRingTokens(refreshToken: string, clientId: string, clientSecret: string, fetcher: typeof fetch = fetch): Promise<RingTokens> {
  return requestTokens(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }), 'refresh', fetcher);
}

async function requestTokens(body: URLSearchParams, operation: 'authorization code' | 'refresh', fetcher: typeof fetch): Promise<RingTokens> {
  let response: Response;
  try {
    response = await fetcher(oauthEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(10000) });
  } catch (error: any) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new RingOAuthError(timedOut ? 504 : 502, 'refresh_failed', timedOut ? 'Ring authorization timed out.' : 'Unable to reach Ring authorization.');
  }
  if (!response.ok) {
    const errorBody = await response.clone().json().catch(() => ({})) as any;
    const oauthError = typeof errorBody.error === 'string' ? errorBody.error : '';
    if (oauthError === 'invalid_grant' || oauthError === 'invalid_token')
      throw new RingOAuthError(response.status, 'reauthorization_required', operation === 'refresh' ? 'Ring authorization is no longer valid. Re-link the Ring account.' : 'Ring did not accept the authorization code. Start linking again.');
    throw new RingOAuthError(response.status >= 500 ? 502 : response.status, 'refresh_failed', 'Ring could not complete authorization.');
  }
  let payload: any;
  try { payload = await response.json(); } catch { throw new RingOAuthError(502, 'refresh_failed', 'Ring returned an invalid authorization response.'); }
  if (typeof payload.access_token !== 'string' || !payload.access_token || typeof payload.refresh_token !== 'string' || !payload.refresh_token || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
    throw new RingOAuthError(502, 'refresh_failed', 'Ring returned an incomplete authorization response.');
  }
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: Date.now() + payload.expires_in * 1000 };
}

export class RingTokenStore {
  constructor(private readonly db: DatabaseSync, private readonly key: Buffer) {
    db.exec(`CREATE TABLE IF NOT EXISTS ring_oauth_tokens(
      account_key TEXT PRIMARY KEY,
      account_id_enc TEXT NOT NULL,
      access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'connected',
      link_state TEXT NOT NULL DEFAULT 'linked',
      version INTEGER NOT NULL DEFAULT 1,
      refresh_owner TEXT,
      refresh_lease_until INTEGER
    )`);
    const columns = db.prepare('PRAGMA table_info(ring_oauth_tokens)').all() as any[];
    if (!columns.some(column => column.name === 'link_state')) db.exec("ALTER TABLE ring_oauth_tokens ADD COLUMN link_state TEXT NOT NULL DEFAULT 'linked'");
    db.exec('CREATE INDEX IF NOT EXISTS ring_oauth_state_idx ON ring_oauth_tokens(state)');
  }

  accountKey(accountId: string): string { return createHmac('sha256', this.key).update(accountId).digest('hex'); }

  save(accountId: string, tokens: RingTokens): void {
    const accountKey = this.accountKey(accountId);
    this.db.prepare(`INSERT INTO ring_oauth_tokens(account_key,account_id_enc,access_token_enc,refresh_token_enc,expires_at,state,version,refresh_owner,refresh_lease_until)
      VALUES(?,?,?,?,?,'connected',1,NULL,NULL) ON CONFLICT(account_key) DO UPDATE SET
      account_id_enc=excluded.account_id_enc,access_token_enc=excluded.access_token_enc,refresh_token_enc=excluded.refresh_token_enc,
      expires_at=excluded.expires_at,state='connected',version=ring_oauth_tokens.version+1,refresh_owner=NULL,refresh_lease_until=NULL`)
      .run(accountKey, encrypt(this.key, 'account', accountId), encrypt(this.key, 'access', tokens.accessToken), encrypt(this.key, 'refresh', tokens.refreshToken), tokens.expiresAt);
  }

  saveUnclaimed(accountId: string, tokens: RingTokens): void {
    const accountKey = this.accountKey(accountId);
    this.db.prepare(`INSERT INTO ring_oauth_tokens(account_key,account_id_enc,access_token_enc,refresh_token_enc,expires_at,state,link_state,version,refresh_owner,refresh_lease_until)
      VALUES(?,?,?,?,?,'connected','unclaimed',1,NULL,NULL) ON CONFLICT(account_key) DO UPDATE SET
      account_id_enc=excluded.account_id_enc,access_token_enc=excluded.access_token_enc,refresh_token_enc=excluded.refresh_token_enc,
      expires_at=excluded.expires_at,state='connected',link_state='unclaimed',version=ring_oauth_tokens.version+1,refresh_owner=NULL,refresh_lease_until=NULL`)
      .run(accountKey, encrypt(this.key, 'account', accountId), encrypt(this.key, 'access', tokens.accessToken), encrypt(this.key, 'refresh', tokens.refreshToken), tokens.expiresAt);
  }

  unclaimedAccounts(): StoredRingTokens[] {
    const rows = this.db.prepare("SELECT account_key FROM ring_oauth_tokens WHERE link_state='unclaimed' AND state='connected'").all() as any[];
    return rows.map(row => this.getByKey(String(row.account_key))).filter((value): value is StoredRingTokens => Boolean(value));
  }

  markLinked(accountId: string): void {
    this.db.prepare("UPDATE ring_oauth_tokens SET link_state='linked' WHERE account_key=? AND link_state='unclaimed'")
      .run(this.accountKey(accountId));
  }

  get(accountId: string): StoredRingTokens | null { return this.getByKey(this.accountKey(accountId)); }

  getFirst(): StoredRingTokens | null {
    const row = this.db.prepare("SELECT account_key FROM ring_oauth_tokens WHERE state!='reauthorization_required' AND link_state='linked' ORDER BY rowid DESC LIMIT 1").get() as any;
    return row ? this.getByKey(String(row.account_key)) : null;
  }

  getStatus(): { linked: boolean; state: RingTokenState | 'authorization_required'; expiresAt: number | null } {
    const row = this.db.prepare("SELECT state, link_state, expires_at FROM ring_oauth_tokens ORDER BY CASE WHEN link_state='linked' THEN 0 ELSE 1 END, rowid DESC LIMIT 1").get() as any;
    if (!row) return { linked: false, state: 'authorization_required', expiresAt: null };
    return { linked: row.link_state === 'linked' && row.state !== 'reauthorization_required', state: row.state, expiresAt: Number(row.expires_at) };
  }

  markReauthorizationRequired(accountId: string): void {
    this.db.prepare("UPDATE ring_oauth_tokens SET state='reauthorization_required',expires_at=0,refresh_owner=NULL,refresh_lease_until=NULL WHERE account_key=?")
      .run(this.accountKey(accountId));
  }

  expireNow(accountId: string): void {
    this.db.prepare('UPDATE ring_oauth_tokens SET expires_at=0 WHERE account_key=?').run(this.accountKey(accountId));
  }

  getByKey(accountKey: string): StoredRingTokens | null {
    const row = this.db.prepare('SELECT * FROM ring_oauth_tokens WHERE account_key=?').get(accountKey) as any;
    if (!row) return null;
    return {
      accountId: decrypt(this.key, 'account', row.account_id_enc),
      accessToken: decrypt(this.key, 'access', row.access_token_enc),
      refreshToken: decrypt(this.key, 'refresh', row.refresh_token_enc),
      expiresAt: Number(row.expires_at), version: Number(row.version), state: row.state, linkState: row.link_state
    };
  }

  claimRefresh(accountId: string, owner: string, leaseMs = 30000, now = Date.now()): boolean {
    const result = this.db.prepare(`UPDATE ring_oauth_tokens SET refresh_owner=?,refresh_lease_until=?
      WHERE account_key=? AND (refresh_lease_until IS NULL OR refresh_lease_until<?)`)
      .run(owner, now + leaseMs, this.accountKey(accountId), now);
    return Number(result.changes) === 1;
  }

  saveRotated(accountId: string, expectedVersion: number, owner: string, tokens: RingTokens): boolean {
    const result = this.db.prepare(`UPDATE ring_oauth_tokens SET access_token_enc=?,refresh_token_enc=?,expires_at=?,state='connected',version=version+1,refresh_owner=NULL,refresh_lease_until=NULL
      WHERE account_key=? AND version=? AND refresh_owner=?`)
      .run(encrypt(this.key, 'access', tokens.accessToken), encrypt(this.key, 'refresh', tokens.refreshToken), tokens.expiresAt, this.accountKey(accountId), expectedVersion, owner);
    return Number(result.changes) === 1;
  }

  releaseRefresh(accountId: string, owner: string, state: 'connected' | 'refresh_failed' | 'reauthorization_required'): void {
    this.db.prepare('UPDATE ring_oauth_tokens SET state=?,refresh_owner=NULL,refresh_lease_until=NULL WHERE account_key=? AND refresh_owner=?')
      .run(state, this.accountKey(accountId), owner);
  }

  unlink(accountId: string): boolean {
    return Number(this.db.prepare('DELETE FROM ring_oauth_tokens WHERE account_key=?').run(this.accountKey(accountId)).changes) === 1;
  }

  async getFreshAccessToken(accountId: string, refresh: (refreshToken: string) => Promise<RingTokens>, now = Date.now()): Promise<string> {
    const accountKey = this.accountKey(accountId);
    const current = this.getByKey(accountKey);
    if (!current) throw new RingOAuthError(404, 'reauthorization_required', 'No Ring account is linked. Authorize Ring to continue.');
    if (current.state === 'reauthorization_required') throw new RingOAuthError(401, 'reauthorization_required', 'Ring authorization is no longer valid. Re-link the Ring account.');
    if (current.expiresAt > now + 60000) return current.accessToken;
    const running = refreshLeases.get(accountKey);
    if (running) return running;
    const task = this.refreshWithLease(accountId, refresh, now);
    refreshLeases.set(accountKey, task);
    try { return await task; } finally { if (refreshLeases.get(accountKey) === task) refreshLeases.delete(accountKey); }
  }

  private async refreshWithLease(accountId: string, refresh: (refreshToken: string) => Promise<RingTokens>, now: number): Promise<string> {
    const accountKey = this.accountKey(accountId);
    const owner = randomUUID();
    const deadline = Date.now() + 35000;
    while (!this.claimRefresh(accountId, owner)) {
      const row = this.getByKey(accountKey);
      if (!row) throw new RingOAuthError(404, 'reauthorization_required', 'No Ring account is linked. Authorize Ring to continue.');
      if (row.state === 'reauthorization_required') throw new RingOAuthError(401, row.state, 'Ring authorization is no longer valid. Re-link the Ring account.');
      if (row.expiresAt > now + 60000) return row.accessToken;
      if (Date.now() >= deadline) throw new RingOAuthError(503, 'refresh_failed', 'Ring token refresh is already in progress. Try again shortly.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const row = this.getByKey(accountKey);
    if (!row) { this.releaseRefresh(accountId, owner, 'reauthorization_required'); throw new RingOAuthError(404, 'reauthorization_required', 'No Ring account is linked. Authorize Ring to continue.'); }
    try {
      const rotated = await refresh(row.refreshToken);
      if (!this.saveRotated(accountId, row.version, owner, rotated)) {
        const newer = this.getByKey(accountKey);
        if (newer && newer.expiresAt > now) return newer.accessToken;
        throw new RingOAuthError(409, 'refresh_failed', 'Ring token state changed during refresh. Try again.');
      }
      return rotated.accessToken;
    } catch (error: any) {
      const state = error instanceof RingOAuthError ? error.state : 'refresh_failed';
      this.releaseRefresh(accountId, owner, state);
      throw error instanceof RingOAuthError ? error : new RingOAuthError(502, 'refresh_failed', 'Unable to refresh Ring authorization.');
    }
  }
}
