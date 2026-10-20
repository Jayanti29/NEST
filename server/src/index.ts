import dotenv from 'dotenv';
import 'express-async-errors';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { exchangeRingAuthorizationCode, parseRingEncryptionKey, refreshRingTokens, ringAccountNonce, RingOAuthError, RingTokenStore, safeStringEqual, verifyRingWebhookSignature } from './ring-auth.js';
import { PostgresRingTokenStore } from './ring-token-store-postgres.js';
import { openStorage } from './storage.js';
import { migrateStorage } from './migrations.js';
import { eventType, requestKind, responseKind, channel } from '../../packages/shared/src/index.js';

if (!process.env.VERCEL) dotenv.config({ path: resolve(process.cwd(), '../.env') });
process.umask(0o077);
const app = express();
app.use(express.json({ limit: '32kb', verify: (req, _res, body) => { (req as any).rawBody = Buffer.from(body); } }));
app.use(express.urlencoded({ extended: false, limit: '8kb' }));
// Optional staging access gate for the UI and application APIs. Ring's public
// callbacks remain reachable; the link form and signed webhook have their own
// validation, and token exchange accepts Ring's one-time authorization code.
const stagingAuthUser = process.env.NEST_STAGING_AUTH_USERNAME;
const stagingAuthPassword = process.env.NEST_STAGING_AUTH_PASSWORD;
app.use((req, res, next) => {
  if (!stagingAuthUser && !stagingAuthPassword) return next();
  if (!stagingAuthUser || !stagingAuthPassword) {
    return fail(res, 503, 'STAGING_AUTH_MISCONFIGURED', 'Staging access is not configured correctly.');
  }
  const publicRingCallbacks = req.path === '/api/ring/link'
    || req.path === '/api/ring/oauth/token-exchange'
    || req.path === '/api/ring/webhook';
  if (req.path === '/api/health' || publicRingCallbacks) return next();
  const authorization = req.get('Authorization') || '';
  const encoded = authorization.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/)?.[1];
  let username = '';
  let password = '';
  if (encoded) {
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        username = decoded.slice(0, separator);
        password = decoded.slice(separator + 1);
      }
    } catch { /* Treat malformed credentials as an authentication failure. */ }
  }
  if (!safeStringEqual(username, stagingAuthUser) || !safeStringEqual(password, stagingAuthPassword)) {
    res.set('WWW-Authenticate', 'Basic realm="NEST staging", charset="UTF-8"');
    res.set('Cache-Control', 'no-store, private');
    return fail(res, 401, 'STAGING_AUTH_REQUIRED', 'Sign in to the NEST staging app.');
  }
  return next();
});
const db = await openStorage();
await migrateStorage(db);
const ringTokenStore = process.env.RING_TOKEN_ENCRYPTION_KEY
  ? db.dialect === 'postgres'
    ? new PostgresRingTokenStore(db, parseRingEncryptionKey(process.env.RING_TOKEN_ENCRYPTION_KEY))
    : new RingTokenStore(db.nativeRingDatabase!, parseRingEncryptionKey(process.env.RING_TOKEN_ENCRYPTION_KEY))
  : null;
const peopleSeed = [
  ['asha','Asha Rao','visual',1,1], ['iyer','Mr. Iyer','speech',1,0], ['meera','Meera','visual',1.25,0], ['kabir','Kabir','picture',1.25,0]
];
const seed = async () => {
  for (const p of peopleSeed) await db.prepare('INSERT INTO people(id,name,primary_mode,text_scale,dementia_mode) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(...p);
  const count = Number((await db.prepare('SELECT count(*) AS n FROM activities').get())?.n || 0);
  if (count) return;
  const rows = [
    ['medicine','Morning tablet','Time for your morning tablet.','08:00',0], ['hydration','Glass of water','A glass of water.','10:30',1], ['meal','Lunch','Lunch is planned.','12:30',0], ['movement','Walk with Priya','A walk and call with Priya.','15:00',1], ['social','Family call','Call with family.','17:00',1], ['meal','Dinner','Dinner is planned.','19:00',0], ['medicine','Evening tablet','Time for your evening tablet.','20:00',0], ['rest','Bedtime routine','Get ready for bed.','21:30',1]
  ];
  for (const person of peopleSeed) {
    for (const [i, row] of rows.entries()) await db.prepare('INSERT INTO activities VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(id) DO NOTHING').run(`${person[0]}-activity-${i+1}`, person[0], ...row);
    for (const [i, label] of ['Front door','Living-room TV','Fan'].entries()) await db.prepare('INSERT INTO devices VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(`${person[0]}-device-${i+1}`,person[0],label,null,null);
  }
  const now = new Date();
  await db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run('seed-door-event','asha','asha-device-1','door_ring','simulated','{}',new Date(now.getTime()-18*60000).toISOString());
  await db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run('seed-tv-event','asha','asha-device-2','tv_on','simulated','{"durationMinutes":12}',new Date(now.getTime()-12*60000).toISOString());
};
await seed();

const ok = (res: express.Response, data: unknown) => res.json({ok:true,data});
const fail = (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ok:false,error:{code,message}});
const personExists = async (id: string) => await db.prepare('SELECT * FROM people WHERE id=?').get(id) as any;
const safePerson = async (req: express.Request, res: express.Response, id: string) => {
  const person = await personExists(id); if (!person) { fail(res,404,'NOT_FOUND','Person not found.'); return null; } return person;
};
const log = async (personId:string, action:string, detail?:string) => db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(randomUUID(),personId,action,detail || null,new Date().toISOString());

const ringAccountIdentifier = () => process.env.RING_PARTNER_ACCOUNT_IDENTIFIER?.trim();
const ringLinkPassword = () => process.env.RING_LINK_PASSWORD;
const ringConfigured = () => ringAppCredentialsConfigured() && Boolean(process.env.RING_TOKEN_ENCRYPTION_KEY && process.env.RING_WEBHOOK_HMAC_KEY?.trim());
const html = (res: express.Response, status: number, message: string) => res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NEST Ring account linking</title><main style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:1rem"><h1>NEST Ring account linking</h1><p>${message}</p></main>`);
const ringLinkAttempts = new Map<string, { count: number; resetAt: number }>();
async function ringApiCall(path: string, method: 'GET' | 'POST' | 'PATCH', accessToken: string, body?: unknown) {
  let response: Response;
  try {
    response = await fetch(`${ringApiBase}${path}`, { method, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  } catch (error: any) {
    throw new Error(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'Ring request timed out.' : 'Unable to reach the Ring API.');
  }
  if (!response.ok) throw new Error(`Ring request failed with HTTP ${response.status}.`);
  return response.status === 204 ? null : response.json();
}

// Ring's one-way (Ring-driven) flow sends the authorization code to this server endpoint.
app.post('/api/ring/oauth/token-exchange', async (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  if (!ringConfigured() || !ringTokenStore) return fail(res, 503, 'RING_NOT_CONFIGURED', 'Ring authorization storage is not configured on the server.');
  const input = z.object({ code: z.string().min(1).max(4096) }).passthrough().safeParse(req.body);
  if (!input.success) return fail(res, 400, 'INVALID_RING_REQUEST', 'Ring token exchange request is missing an authorization code.');
  try {
    const tokens = await exchangeRingAuthorizationCode(input.data.code, process.env.RING_CLIENT_ID!.trim(), process.env.RING_CLIENT_SECRET!.trim());
    const profile: any = await ringApiCall('/users/me', 'GET', tokens.accessToken);
    const accountId = profile?.data?.id;
    if (typeof accountId !== 'string' || !accountId.startsWith('ava1.ring.account.')) return fail(res, 502, 'RING_PROFILE_INVALID', 'Ring returned an invalid account profile.');
    await ringTokenStore.saveUnclaimed(accountId, tokens);
    return res.status(200).json({ status: 'received' });
  } catch (error: any) {
    const status = error instanceof RingOAuthError ? error.status : 502;
    return fail(res, status, 'RING_TOKEN_EXCHANGE_FAILED', error.message || 'Ring token exchange failed.');
  }
});

app.get('/api/ring/link', (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  if (!ringConfigured() || !ringTokenStore || !ringLinkPassword() || !ringAccountIdentifier()) return html(res, 503, 'Ring account linking needs server-side credentials, an encryption key, and the configured NEST account identity.');
  const time = typeof req.query.time === 'string' ? req.query.time : '';
  const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
  if (!/^\d{13}$/.test(time) || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return html(res, 400, 'This Ring link request is incomplete. Start account linking again from Ring.');
  return res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Link Ring to NEST</title><main style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:1rem"><h1>Link Ring to NEST</h1><p>Sign in to your NEST account to finish linking. Ring account access remains private to this server.</p><form method="post" action="/api/ring/link"><input type="hidden" name="time" value="${time}"><input type="hidden" name="nonce" value="${nonce}"><label>NEST account identifier<br><input name="account_identifier" autocomplete="username" required></label><p><label>NEST link password<br><input type="password" name="password" autocomplete="current-password" required></label></p><button>Sign in and link</button></form></main>`);
});

app.post('/api/ring/link', async (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  const input = z.object({ time: z.string().regex(/^\d{13}$/), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), account_identifier: z.string().min(3).max(254), password: z.string().min(1).max(256) }).strict().safeParse(req.body);
  const linkPassword = ringLinkPassword();
  const expectedIdentifier = ringAccountIdentifier();
  if (!input.success || !ringTokenStore || !ringConfigured() || !linkPassword || !expectedIdentifier) return html(res, 400, 'Unable to validate this account-link request. Start again from Ring.');
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const attempt = ringLinkAttempts.get(ip);
  if (attempt && attempt.resetAt > Date.now() && attempt.count >= 8) return html(res, 429, 'Too many sign-in attempts. Wait 10 minutes and try again.');
  if (!attempt || attempt.resetAt <= Date.now()) ringLinkAttempts.set(ip, { count: 1, resetAt: Date.now() + 600000 }); else attempt.count++;
  if (!safeStringEqual(input.data.password, linkPassword) || !safeStringEqual(input.data.account_identifier, expectedIdentifier)) return html(res, 401, 'Sign-in failed. Check your account details and try again.');
  const timestamp = Number(input.data.time);
  const delta = Date.now() - timestamp;
  if (delta < 0 || delta > 600000) return html(res, 400, 'This Ring link request expired. Start account linking again.');
  const unclaimed = await ringTokenStore.unclaimedAccounts();
  const match = unclaimed.find(record => safeStringEqual(ringAccountNonce(input.data.time, record.accountId, process.env.RING_WEBHOOK_HMAC_KEY!.trim()), input.data.nonce));
  if (!match) return html(res, 400, 'This Ring link request could not be verified. Start account linking again.');
  try {
    await ringApiCall('/accounts/me/app-integrations', 'POST', match.accessToken, { account_identifier: expectedIdentifier, nonce: input.data.nonce });
    await ringApiCall('/accounts/me/app-integrations', 'PATCH', match.accessToken, { status: 'completed' });
    await ringTokenStore.markLinked(match.accountId);
    return html(res, 200, 'Your Ring account is linked. You can return to NEST.');
  } catch {
    return html(res, 502, 'Ring could not finish account linking. Try again from Ring; no credentials were shown.');
  }
});

app.post('/api/ring/webhook', async (req, res) => {
  res.set('Cache-Control', 'no-store, private');
  const secret = process.env.RING_WEBHOOK_HMAC_KEY?.trim();
  const signature = req.get('X-Signature') || '';
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!secret || !rawBody || !verifyRingWebhookSignature(rawBody, signature, secret)) return fail(res, 401, 'INVALID_WEBHOOK_SIGNATURE', 'Ring webhook signature is invalid.');
  const payload = z.object({ meta: z.object({ request_id: z.string().min(1).max(128), account_id: z.string().min(1).max(128) }), data: z.object({ type: z.string().min(1).max(100) }) }).passthrough().safeParse(req.body);
  if (!payload.success) return fail(res, 400, 'INVALID_WEBHOOK', 'Ring webhook payload is invalid.');
  try {
    if (payload.data.data.type === 'app_integration_removed') await ringTokenStore?.unlink(payload.data.meta.account_id);
    const inserted = await db.prepare('INSERT INTO ring_webhook_receipts VALUES(?,?) ON CONFLICT(request_id) DO NOTHING').run(payload.data.meta.request_id, new Date().toISOString());
    return res.status(200).json({ status: inserted.changes ? 'processed' : 'already_processed' });
  } catch { return fail(res, 500, 'WEBHOOK_PROCESSING_FAILED', 'Ring webhook could not be processed.'); }
});

const ringApiBase = 'https://api.amazonvision.com/v1';
const ringToken = () => process.env.RING_ACCESS_TOKEN?.trim();
const ringAppCredentialsConfigured = () => Boolean(process.env.RING_CLIENT_ID?.trim() && process.env.RING_CLIENT_SECRET?.trim());
let ringVerifiedAt: string | null = null;
const ringTokenExpiry = (token: string) => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch { return null; }
};
async function ringGet(path: string) {
  const linked = await ringTokenStore?.getFirst() || null;
  const token = linked && ringTokenStore
    ? await ringTokenStore.getFreshAccessToken(linked.accountId, refreshToken => {
      if (!ringAppCredentialsConfigured()) throw Object.assign(new Error('Ring app credentials are not configured.'), { status: 503 });
      return refreshRingTokens(refreshToken, process.env.RING_CLIENT_ID!.trim(), process.env.RING_CLIENT_SECRET!.trim());
    })
    : ringToken();
  if (!token) throw Object.assign(new Error('No Ring account is linked. Complete Ring authorization before making API requests.'), { status: 503 });
  const send = async (accessToken: string) => {
    try {
      return await fetch(`${ringApiBase}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
    } catch (error: any) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw Object.assign(new Error(timedOut ? 'Ring request timed out. Try again.' : 'Unable to reach the Ring API.'), { status: timedOut ? 504 : 502 });
    }
  };
  let response = await send(token);
  if (response.status === 401 && linked && ringTokenStore) {
    await ringTokenStore.expireNow(linked.accountId);
    try {
      const refreshed = await ringTokenStore.getFreshAccessToken(linked.accountId, refreshToken => {
        if (!ringAppCredentialsConfigured()) throw Object.assign(new Error('Ring app credentials are not configured.'), { status: 503 });
        return refreshRingTokens(refreshToken, process.env.RING_CLIENT_ID!.trim(), process.env.RING_CLIENT_SECRET!.trim());
      });
      response = await send(refreshed);
      if (response.status === 401) await ringTokenStore.markReauthorizationRequired(linked.accountId);
    } catch (error) { throw error; }
  }
  if (!response.ok) {
    const status = response.status;
    const message = status === 401 ? 'Ring authorization was rejected. Re-link the Ring account.'
      : status === 403 ? 'Ring denied this request. Check the app permissions and token scope.'
      : status === 429 ? 'Ring rate limit reached. Wait before trying again.'
      : 'Ring could not complete this request.';
    throw Object.assign(new Error(message), { status: status === 401 ? 401 : status === 403 ? 403 : status === 429 ? 429 : 502 });
  }
  ringVerifiedAt = new Date().toISOString();
  return response.json();
}
const ringEndpoint = (req: express.Request, res: express.Response, path: string) => {
  res.set('Cache-Control','no-store, private');
  ringGet(path).then(data => ok(res, { source: 'Ring API', data })).catch((error: any) => {
    const status = Number(error.status) || 502;
    fail(res, status, status === 401 ? 'RING_TOKEN_EXPIRED' : status === 403 ? 'RING_FORBIDDEN' : status === 429 ? 'RING_RATE_LIMITED' : status === 503 ? 'RING_NOT_CONFIGURED' : status === 504 ? 'RING_TIMEOUT' : 'RING_UNAVAILABLE', error.message || 'Ring is unavailable.');
  });
};

app.get('/api/health', async (_req,res) => {
  try {
    await db.prepare('SELECT 1 AS ok').get();
    return ok(res,{status:'ready',simulator:process.env.NEST_SIMULATOR !== 'off',aiProvider:process.env.NEST_AI_PROVIDER || 'mock'});
  } catch {
    return fail(res,503,'NOT_READY','The application database is not ready.');
  }
});
app.get('/api/ring/health', async (_req,res) => {
  res.set('Cache-Control','no-store, private');
  const stored=await ringTokenStore?.getStatus();
  const token=ringToken(); const expiresAt=stored?.expiresAt ?? (token?ringTokenExpiry(token):null);
  const expired=Boolean(token && !stored?.linked && expiresAt !== null && expiresAt <= Date.now());
  const clientIdConfigured=Boolean(process.env.RING_CLIENT_ID?.trim());
  const clientSecretConfigured=Boolean(process.env.RING_CLIENT_SECRET?.trim());
  const credentialsConfigured=clientIdConfigured&&clientSecretConfigured;
  const encryptionKeyConfigured=Boolean(ringTokenStore);
  const webhookKeyConfigured=Boolean(process.env.RING_WEBHOOK_HMAC_KEY?.trim());
  const accountIdentifierConfigured=Boolean(ringAccountIdentifier());
  const linkPasswordConfigured=Boolean(ringLinkPassword());
  const tokenAvailable=Boolean(stored?.linked || token);
  const linkConfigurationReady=ringConfigured()&&linkPasswordConfigured&&accountIdentifierConfigured;
  const status=stored?.state==='reauthorization_required'?'reauthorization_required':stored?.state==='refresh_failed'?'token_refresh_failed':expired?'token_expired':ringVerifiedAt?'connected':tokenAvailable?'token_unverified':linkConfigurationReady?'authorization_required':'not_configured';
  ok(res,{status,clientIdConfigured,clientSecretConfigured,credentialsConfigured,encryptionKeyConfigured,webhookKeyConfigured,accountIdentifierConfigured,linkPasswordConfigured,accountLinkingConfigured:ringConfigured()&&linkPasswordConfigured&&accountIdentifierConfigured,accessTokenConfigured:tokenAvailable,tokenExpired:expired,tokenExpiresInMinutes:expiresAt?Math.max(0,Math.ceil((expiresAt-Date.now())/60000)):null,verifiedAt:ringVerifiedAt,transport:'server-to-server'});
});
app.get('/api/ring/users/me', (req,res) => ringEndpoint(req,res,'/users/me'));
app.get('/api/ring/devices', (req,res) => ringEndpoint(req,res,'/devices?include=status,capabilities,location,configurations'));
app.get('/api/ring/devices/:deviceId', (req,res) => {
  const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).safeParse(req.params.deviceId);
  if(!id.success)return fail(res,400,'VALIDATION_FAILED','Invalid Ring device id.');
  ringEndpoint(req,res,`/devices/${encodeURIComponent(id.data)}`);
});
for (const endpoint of ['status','capabilities','location','configurations'] as const) {
  app.get(`/api/ring/devices/:deviceId/${endpoint}`, (req,res) => {
    const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).safeParse(req.params.deviceId);
    if(!id.success)return fail(res,400,'VALIDATION_FAILED','Invalid Ring device id.');
    ringEndpoint(req,res,`/devices/${encodeURIComponent(id.data)}/${endpoint}`);
  });
}
app.get('/api/ring/devices/:deviceId/events', (req,res) => {
  const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/).safeParse(req.params.deviceId);
  if(!id.success)return fail(res,400,'VALIDATION_FAILED','Invalid Ring device id.');
  const query=z.object({since:z.string().datetime().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).safeParse(req.query);
  if(!query.success)return fail(res,400,'VALIDATION_FAILED','Check the event-history filters.');
  const params=new URLSearchParams(); if(query.data.since)params.set('since',query.data.since); if(query.data.limit)params.set('limit',String(query.data.limit));
  const suffix=params.size?`?${params.toString()}`:'';
  ringEndpoint(req,res,`/history/devices/${encodeURIComponent(id.data)}/events${suffix}`);
});
app.get('/api/people', async (_req,res) => ok(res,await db.prepare('SELECT id, name, primary_mode AS primaryMode, text_scale AS textScale, dementia_mode AS dementiaMode FROM people').all()));
app.get('/api/people/:id', async (req,res) => { const p=await safePerson(req,res,req.params.id); if(p) ok(res,p); });
app.patch('/api/people/:id/preferences', async (req,res) => {
  const p=await safePerson(req,res,req.params.id); if(!p) return;
  const schema=z.object({primaryMode:z.enum(['speech','visual','picture']).optional(),textScale:z.union([z.literal(1),z.literal(1.25),z.literal(1.5)]).optional(),dementiaMode:z.boolean().optional()}).strict();
  const v=schema.safeParse(req.body); if(!v.success) return fail(res,400,'VALIDATION_FAILED','Check the preference values.');
  await db.prepare('UPDATE people SET primary_mode=coalesce(?,primary_mode),text_scale=coalesce(?,text_scale),dementia_mode=coalesce(?,dementia_mode) WHERE id=?').run(v.data.primaryMode??null,v.data.textScale??null,v.data.dementiaMode===undefined?null:Number(v.data.dementiaMode),p.id);
  ok(res,await personExists(p.id));
});
const activities = async (id:string) => await db.prepare(`SELECT a.*, coalesce(r.kind,'upcoming') state, r.at respondedAt FROM activities a LEFT JOIN responses r ON r.activity_id=a.id WHERE a.person_id=? ORDER BY a.time`).all(id) as any[];
app.get('/api/people/:id/day', async (req,res) => {
  const p=await safePerson(req,res,req.params.id); if(!p) return;
  const now = new Date(); const hhmm = now.toTimeString().slice(0,5);
  const rows=await activities(p.id); const next=rows.find(a=>!['acknowledged','declined'].includes(a.state) && a.time>=hhmm) || rows.find(a=>a.state==='upcoming');
  ok(res,{person:{id:p.id,name:p.name},now:now.toISOString(),date:now.toISOString().slice(0,10),next:next||null,later:rows.filter(a=>a!==next&&a.state==='upcoming').slice(0,3)});
});
app.get('/api/people/:id/routine', async (req,res) => { const p=await safePerson(req,res,req.params.id); if(p) ok(res,await activities(p.id)); });
app.get('/api/people/:id/activities', async (req,res) => { const p=await safePerson(req,res,req.params.id); if(p) ok(res,await activities(p.id)); });
app.post('/api/occurrences/:id/respond', async (req,res) => {
  const v=z.object({kind:responseKind,channel}).strict().safeParse(req.body); if(!v.success) return fail(res,400,'VALIDATION_FAILED','Choose a valid response.');
  const a=await db.prepare('SELECT * FROM activities WHERE id=?').get(req.params.id) as any; if(!a) return fail(res,404,'NOT_FOUND','Reminder not found.');
  if(v.data.kind==='postponed'&&!a.allow_postpone) return fail(res,409,'RULE_BLOCKED','This reminder cannot be postponed.');
  const at=new Date().toISOString(); await db.prepare('INSERT INTO responses VALUES(?,?,?,?,?)').run(randomUUID(),a.id,v.data.kind,v.data.channel,at); await log(a.person_id,`reminder_${v.data.kind}`,a.title);
  ok(res,{...a,state:v.data.kind,respondedAt:at,acknowledgedOnly:v.data.kind==='acknowledged'});
});
app.get('/api/people/:id/devices', async (req,res) => { const p=await safePerson(req,res,req.params.id); if(p) ok(res,(await db.prepare('SELECT * FROM devices WHERE person_id=?').all(p.id)).map((d:any)=>({...d,status:'no_data',statusLabel:'No data received',source:'Simulated'}))); });
app.get('/api/people/:id/events', async (req,res) => { const p=await safePerson(req,res,req.params.id); if(p) ok(res,await db.prepare('SELECT * FROM events WHERE person_id=? ORDER BY at DESC LIMIT 100').all(p.id)); });
app.post('/api/sim/events', async (req,res) => {
  if(process.env.NEST_SIMULATOR==='off') return fail(res,404,'NOT_FOUND','The simulator is disabled.');
  const v=z.object({personId:z.string(),type:eventType,detail:z.record(z.unknown()).optional()}).strict().safeParse(req.body); if(!v.success) return fail(res,400,'VALIDATION_FAILED','Choose a valid simulated event.');
  const p=await safePerson(req,res,v.data.personId); if(!p) return;
  const map:any={door_ring:'Front door',door_left_open:'Front door',tv_on:'Living-room TV',tv_prolonged:'Living-room TV',fan_changed:'Fan'};
  const d=map[v.data.type]?await db.prepare('SELECT id FROM devices WHERE person_id=? AND label=?').get(p.id,map[v.data.type]) as any:null;
  const event={id:randomUUID(),person_id:p.id,device_id:d?.id||null,type:v.data.type,provenance:'simulated',detail:JSON.stringify(v.data.detail||{}),at:new Date().toISOString()};
  await db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(event.id,event.person_id,event.device_id,event.type,event.provenance,event.detail,event.at); await log(p.id,'simulated_event',v.data.type); ok(res,event);
});
app.post('/api/sim/clock', (req,res) => ok(res,{now:new Date().toISOString(),note:'Clock simulation is recorded as demo data.'}));
app.post('/api/sim/reset', async (_req,res) => { await db.prepare('DELETE FROM responses').run(); await db.prepare('DELETE FROM requests').run(); await db.prepare('DELETE FROM checkins').run(); await db.prepare('DELETE FROM events').run(); await seed(); const now=Date.now(); await db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),'asha','asha-device-1','door_ring','simulated','{}',new Date(now-18*60000).toISOString()); await db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),'asha','asha-device-2','tv_on','simulated','{"durationMinutes":12}',new Date(now-12*60000).toISOString()); ok(res,{reset:true}); });
app.post('/api/people/:id/requests', async (req,res) => {
  const p=await safePerson(req,res,req.params.id); if(!p)return;
  const v=z.object({kind:requestKind}).strict().safeParse(req.body); if(!v.success)return fail(res,400,'VALIDATION_FAILED','Choose a request.');
  const phrases:any={water:'I need water',food:'I need food',pain:'I am in pain',help:'I need help',toilet:'I need the toilet',rest:'I need to rest',music:'I would like music',call_family:'I would like to call family'};
  const row={id:randomUUID(),person_id:p.id,kind:v.data.kind,phrase:phrases[v.data.kind],at:new Date().toISOString()}; await db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,NULL)').run(row.id,row.person_id,row.kind,row.phrase,row.at); await log(p.id,'picture_request',row.kind); ok(res,row);
});
app.get('/api/people/:id/requests', async (req,res) => { const p=await safePerson(req,res,req.params.id); if(p) ok(res,await db.prepare('SELECT * FROM requests WHERE person_id=? AND undone_at IS NULL ORDER BY at DESC').all(p.id)); });
app.post('/api/requests/:id/undo', async (req,res) => { const row=await db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id) as any; if(!row)return fail(res,404,'NOT_FOUND','Request not found.'); if(Date.now()-Date.parse(row.at)>8000)return fail(res,409,'RULE_BLOCKED','The undo period has ended.'); await db.prepare('UPDATE requests SET undone_at=? WHERE id=?').run(new Date().toISOString(),row.id); ok(res,{undone:true}); });
app.post('/api/people/:id/checkins', async (req,res) => { const p=await safePerson(req,res,req.params.id); if(!p)return; const v=z.object({reason:z.string().min(1).max(300)}).strict().safeParse(req.body); if(!v.success)return fail(res,400,'VALIDATION_FAILED','Add a short reason.'); const c={id:randomUUID(),person_id:p.id,reason:v.data.reason,origin:'person',state:'open',at:new Date().toISOString()}; await db.prepare('INSERT INTO checkins VALUES(?,?,?,?,?,?,?)').run(c.id,c.person_id,c.reason,c.origin,c.state,c.at); await log(p.id,'checkin_requested',c.reason); ok(res,c); });
app.get('/api/people/:id/checkins', async (req,res) => { const p=await safePerson(req,res,req.params.id); if(p)ok(res,await db.prepare('SELECT * FROM checkins WHERE person_id=? ORDER BY at DESC').all(p.id)); });
app.patch('/api/checkins/:id', async (req,res) => { const v=z.object({state:z.enum(['seen','resolved'])}).strict().safeParse(req.body); if(!v.success)return fail(res,400,'VALIDATION_FAILED','Choose seen or resolved.'); const c=await db.prepare('SELECT * FROM checkins WHERE id=?').get(req.params.id) as any; if(!c)return fail(res,404,'NOT_FOUND','Check-in not found.'); await db.prepare('UPDATE checkins SET state=? WHERE id=?').run(v.data.state,c.id); ok(res,{...c,state:v.data.state}); });
app.get('/api/people/:id/care/summary', async (req,res) => { const p=await safePerson(req,res,req.params.id); if(!p)return; const missed=(await activities(p.id)).filter(a=>a.state==='not_answered'); const checkins=await db.prepare("SELECT * FROM checkins WHERE person_id=? AND state!='resolved' ORDER BY at DESC").all(p.id); ok(res,{needsReview:[...missed,...checkins],counts:{missed:missed.length,checkins:checkins.length}}); });
app.get('/api/people/:id/care/timeline', async (req,res) => { const p=await safePerson(req,res,req.params.id); if(!p)return; const ev=await db.prepare('SELECT id,at,type,provenance,detail FROM events WHERE person_id=? ORDER BY at DESC').all(p.id) as any[]; const rs=await db.prepare('SELECT r.id,r.at,r.kind,a.title FROM responses r JOIN activities a ON a.id=r.activity_id WHERE a.person_id=? ORDER BY r.at DESC').all(p.id) as any[]; const requests=await db.prepare('SELECT id,at,phrase,kind FROM requests WHERE person_id=? AND undone_at IS NULL ORDER BY at DESC').all(p.id) as any[]; ok(res,[...ev.map(e=>({...e,kind:'event',title:e.type.replaceAll('_',' '),status:e.provenance})),...rs.map(r=>({...r,kind:'reminder',status:r.kind==='acknowledged'?'acknowledged':'not acknowledged'})),...requests.map(r=>({...r,kind:'request',title:r.phrase,status:'open'}))].sort((a:any,b:any)=>b.at.localeCompare(a.at))); });

// The mock provider is deterministic and offline-capable. Bedrock is enabled server-side by configuration.
app.post('/api/people/:id/assistant', async (req,res) => {
  const p=await safePerson(req,res,req.params.id); if(!p)return;
  const v=z.object({message:z.string().min(1).max(500)}).strict().safeParse(req.body); if(!v.success)return fail(res,400,'VALIDATION_FAILED','Enter a message of up to 500 characters.');
  const message=v.data.message.toLowerCase(); const calls:any[]=[]; let reply='I can help with today’s routine, recorded home events, or a caregiver check-in.';
  if(/next|routine|plan|schedule/.test(message)){const data=await activities(p.id);calls.push({name:'get_daily_routine',input:{},output:data,ok:true,durationMs:1});const next=data.find(a=>a.state==='upcoming');reply=next?`The next planned item is ${next.title} at ${next.time}.`:'There are no upcoming items in today’s plan.';}
  if(/door|event|tv|home|device/.test(message)){const data=await db.prepare('SELECT type,provenance,at FROM events WHERE person_id=? ORDER BY at DESC LIMIT 10').all(p.id);calls.push({name:'get_home_events',input:{limit:10},output:data,ok:true,durationMs:1});reply=data.length?`The latest recorded home event is ${String((data[0] as any).type).replaceAll('_',' ')} (simulated).`:'No home events are recorded. That does not mean nothing happened.';}
  if(/help|check.?in|caregiver|family/.test(message)){const c={id:randomUUID(),person_id:p.id,reason:v.data.message,origin:'assistant',state:'open',at:new Date().toISOString()}; await db.prepare('INSERT INTO checkins VALUES(?,?,?,?,?,?,?)').run(c.id,c.person_id,c.reason,c.origin,c.state,c.at);calls.push({name:'request_caregiver_checkin',input:{reason:v.data.message},output:c,ok:true,durationMs:1});reply='I asked your Care Circle to check in.';}
  const blocked=/\bsafe\b|\beverything is fine\b|\b(taken your medicine|medicine taken)\b/i; if(blocked.test(reply))reply='I cannot confirm that. You can ask your Care Circle to check in.';
  ok(res,{messageId:randomUUID(),text:reply,toolCalls:calls});
});
app.get('/api/people/:id/assistant/history', (_req,res) => ok(res,[]));
app.use('/api',(_req,res) => fail(res,404,'NOT_FOUND','This page could not be found.'));
app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error);
  res.set('Cache-Control', 'no-store, private');
  if (req.path.startsWith('/api/')) return fail(res,500,'INTERNAL_ERROR','The request could not be completed. Try again.');
  return res.status(500).send('The request could not be completed.');
});
if (!process.env.VERCEL) {
  app.use(express.static(resolve(process.cwd(),'../client/dist')));
  app.get('*',(_req,res) => res.sendFile(resolve(process.cwd(),'../client/dist/index.html')));
  const port=Number(process.env.PORT||3001);
  const host=process.env.HOST||(process.env.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1');
  app.listen(port,host,()=>console.log(`NEST API listening on ${host}:${port}`));
}

export default app;
