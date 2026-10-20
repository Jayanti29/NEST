import dotenv from 'dotenv';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { eventType, requestKind, responseKind, channel } from '../../packages/shared/src/index.js';

dotenv.config({ path: resolve(process.cwd(), '../.env') });
const app = express();
app.use(express.json({ limit: '32kb' }));
const db = new DatabaseSync(process.env.NEST_DB_PATH || 'nest.sqlite');
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_mode TEXT NOT NULL DEFAULT 'visual',text_scale REAL NOT NULL DEFAULT 1,dementia_mode INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,instruction TEXT NOT NULL,time TEXT NOT NULL,allow_postpone INTEGER NOT NULL DEFAULT 1,approved INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS responses(id TEXT PRIMARY KEY,activity_id TEXT NOT NULL,kind TEXT NOT NULL,channel TEXT NOT NULL,at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,label TEXT NOT NULL,state TEXT,last_reported_at TEXT);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,device_id TEXT,type TEXT NOT NULL,provenance TEXT NOT NULL,detail TEXT,at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,kind TEXT NOT NULL,phrase TEXT NOT NULL,at TEXT NOT NULL,undone_at TEXT);
CREATE TABLE IF NOT EXISTS checkins(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,reason TEXT NOT NULL,origin TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'open',at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,person_id TEXT,action TEXT NOT NULL,detail TEXT,at TEXT NOT NULL);
`);
const peopleSeed = [
  ['asha','Asha Rao','visual',1,1], ['iyer','Mr. Iyer','speech',1,0], ['meera','Meera','visual',1.25,0], ['kabir','Kabir','picture',1.25,0]
];
const seed = () => {
  db.exec('BEGIN');
  for (const p of peopleSeed) db.prepare('INSERT OR IGNORE INTO people VALUES(?,?,?,?,?)').run(...p);
  const count = Number(db.prepare('SELECT count(*) AS n FROM activities').get()?.n || 0);
  if (count) { db.exec('COMMIT'); return; }
  const rows = [
    ['medicine','Morning tablet','Time for your morning tablet.','08:00',0], ['hydration','Glass of water','A glass of water.','10:30',1], ['meal','Lunch','Lunch is planned.','12:30',0], ['movement','Walk with Priya','A walk and call with Priya.','15:00',1], ['social','Family call','Call with family.','17:00',1], ['meal','Dinner','Dinner is planned.','19:00',0], ['medicine','Evening tablet','Time for your evening tablet.','20:00',0], ['rest','Bedtime routine','Get ready for bed.','21:30',1]
  ];
  for (const person of peopleSeed) {
    rows.forEach((row,i) => db.prepare('INSERT INTO activities VALUES(?,?,?,?,?,?,?,1)').run(`${person[0]}-activity-${i+1}`, person[0], ...row));
    ['Front door','Living-room TV','Fan'].forEach((label,i) => db.prepare('INSERT INTO devices VALUES(?,?,?,?,?)').run(`${person[0]}-device-${i+1}`,person[0],label,null,null));
  }
  const now = new Date();
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),'asha','asha-device-1','door_ring','simulated','{}',new Date(now.getTime()-18*60000).toISOString());
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),'asha','asha-device-2','tv_on','simulated','{"durationMinutes":12}',new Date(now.getTime()-12*60000).toISOString());
  db.exec('COMMIT');
};
seed();

const ok = (res: express.Response, data: unknown) => res.json({ok:true,data});
const fail = (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ok:false,error:{code,message}});
const personExists = (id: string) => db.prepare('SELECT * FROM people WHERE id=?').get(id) as any;
const safePerson = (req: express.Request, res: express.Response, id: string) => {
  const person = personExists(id); if (!person) { fail(res,404,'NOT_FOUND','Person not found.'); return null; } return person;
};
const log = (personId:string, action:string, detail?:string) => db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(randomUUID(),personId,action,detail || null,new Date().toISOString());

const ringApiBase = 'https://api.amazonvision.com/v1';
const ringToken = () => process.env.RING_ACCESS_TOKEN?.trim();
const ringAppCredentialsConfigured = () => Boolean(process.env.RING_CLIENT_ID?.trim() && process.env.RING_CLIENT_SECRET?.trim());
const ringTokenExpiry = (token: string) => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch { return null; }
};
async function ringGet(path: string) {
  const token = ringToken();
  if (!token) throw Object.assign(new Error('Ring access token is not configured on the server.'), { status: 503 });
  let response: Response;
  try {
    response = await fetch(`${ringApiBase}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
  } catch (error: any) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw Object.assign(new Error(timedOut ? 'Ring request timed out. Try again.' : 'Unable to reach the Ring API.'), { status: timedOut ? 504 : 502 });
  }
  if (!response.ok) {
    const status = response.status;
    const message = status === 401 ? 'The Ring token expired or was rejected. Generate a new temporary token.'
      : status === 403 ? 'Ring denied this request. Check the app permissions and token scope.'
      : status === 429 ? 'Ring rate limit reached. Wait before trying again.'
      : 'Ring could not complete this request.';
    throw Object.assign(new Error(message), { status: status === 401 ? 401 : status === 403 ? 403 : status === 429 ? 429 : 502 });
  }
  return response.json();
}
const ringEndpoint = (req: express.Request, res: express.Response, path: string) => {
  res.set('Cache-Control','no-store, private');
  ringGet(path).then(data => ok(res, { source: 'Ring API', data })).catch((error: any) => {
    const status = Number(error.status) || 502;
    fail(res, status, status === 401 ? 'RING_TOKEN_EXPIRED' : status === 403 ? 'RING_FORBIDDEN' : status === 429 ? 'RING_RATE_LIMITED' : status === 503 ? 'RING_NOT_CONFIGURED' : status === 504 ? 'RING_TIMEOUT' : 'RING_UNAVAILABLE', error.message || 'Ring is unavailable.');
  });
};

app.get('/api/health', (_req,res) => ok(res,{status:'ready',simulator:process.env.NEST_SIMULATOR !== 'off',aiProvider:process.env.NEST_AI_PROVIDER || 'mock'}));
app.get('/api/ring/health', (_req,res) => {
  res.set('Cache-Control','no-store, private');
  const token=ringToken(); const expiresAt=token?ringTokenExpiry(token):null;
  const expired=Boolean(expiresAt && expiresAt<=Date.now());
  const credentialsConfigured=ringAppCredentialsConfigured();
  const status=expired?'token_expired':token?'token_unverified':credentialsConfigured?'authorization_required':'credentials_missing';
  ok(res,{status,credentialsConfigured,accessTokenConfigured:Boolean(token),tokenExpired:expired,tokenExpiresInMinutes:expiresAt?Math.max(0,Math.ceil((expiresAt-Date.now())/60000)):null,transport:'server-to-server'});
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
app.get('/api/people', (_req,res) => ok(res,db.prepare('SELECT id, name, primary_mode AS primaryMode, text_scale AS textScale, dementia_mode AS dementiaMode FROM people').all()));
app.get('/api/people/:id', (req,res) => { const p=safePerson(req,res,req.params.id); if(p) ok(res,p); });
app.patch('/api/people/:id/preferences', (req,res) => {
  const p=safePerson(req,res,req.params.id); if(!p) return;
  const schema=z.object({primaryMode:z.enum(['speech','visual','picture']).optional(),textScale:z.union([z.literal(1),z.literal(1.25),z.literal(1.5)]).optional(),dementiaMode:z.boolean().optional()}).strict();
  const v=schema.safeParse(req.body); if(!v.success) return fail(res,400,'VALIDATION_FAILED','Check the preference values.');
  db.prepare('UPDATE people SET primary_mode=coalesce(?,primary_mode),text_scale=coalesce(?,text_scale),dementia_mode=coalesce(?,dementia_mode) WHERE id=?').run(v.data.primaryMode??null,v.data.textScale??null,v.data.dementiaMode===undefined?null:Number(v.data.dementiaMode),p.id);
  ok(res,personExists(p.id));
});
const activities = (id:string) => db.prepare(`SELECT a.*, coalesce(r.kind,'upcoming') state, r.at respondedAt FROM activities a LEFT JOIN responses r ON r.activity_id=a.id WHERE a.person_id=? ORDER BY a.time`).all(id) as any[];
app.get('/api/people/:id/day', (req,res) => {
  const p=safePerson(req,res,req.params.id); if(!p) return;
  const now = new Date(); const hhmm = now.toTimeString().slice(0,5);
  const rows=activities(p.id); const next=rows.find(a=>!['acknowledged','declined'].includes(a.state) && a.time>=hhmm) || rows.find(a=>a.state==='upcoming');
  ok(res,{person:{id:p.id,name:p.name},now:now.toISOString(),date:now.toISOString().slice(0,10),next:next||null,later:rows.filter(a=>a!==next&&a.state==='upcoming').slice(0,3)});
});
app.get('/api/people/:id/routine', (req,res) => { const p=safePerson(req,res,req.params.id); if(p) ok(res,activities(p.id)); });
app.get('/api/people/:id/activities', (req,res) => { const p=safePerson(req,res,req.params.id); if(p) ok(res,activities(p.id)); });
app.post('/api/occurrences/:id/respond', (req,res) => {
  const v=z.object({kind:responseKind,channel}).strict().safeParse(req.body); if(!v.success) return fail(res,400,'VALIDATION_FAILED','Choose a valid response.');
  const a=db.prepare('SELECT * FROM activities WHERE id=?').get(req.params.id) as any; if(!a) return fail(res,404,'NOT_FOUND','Reminder not found.');
  if(v.data.kind==='postponed'&&!a.allow_postpone) return fail(res,409,'RULE_BLOCKED','This reminder cannot be postponed.');
  const at=new Date().toISOString(); db.prepare('INSERT INTO responses VALUES(?,?,?,?,?)').run(randomUUID(),a.id,v.data.kind,v.data.channel,at); log(a.person_id,`reminder_${v.data.kind}`,a.title);
  ok(res,{...a,state:v.data.kind,respondedAt:at,acknowledgedOnly:v.data.kind==='acknowledged'});
});
app.get('/api/people/:id/devices', (req,res) => { const p=safePerson(req,res,req.params.id); if(p) ok(res,db.prepare('SELECT * FROM devices WHERE person_id=?').all(p.id).map((d:any)=>({...d,status:'no_data',statusLabel:'No data received',source:'Simulated'}))); });
app.get('/api/people/:id/events', (req,res) => { const p=safePerson(req,res,req.params.id); if(p) ok(res,db.prepare('SELECT * FROM events WHERE person_id=? ORDER BY at DESC LIMIT 100').all(p.id)); });
app.post('/api/sim/events', (req,res) => {
  if(process.env.NEST_SIMULATOR==='off') return fail(res,404,'NOT_FOUND','The simulator is disabled.');
  const v=z.object({personId:z.string(),type:eventType,detail:z.record(z.unknown()).optional()}).strict().safeParse(req.body); if(!v.success) return fail(res,400,'VALIDATION_FAILED','Choose a valid simulated event.');
  const p=safePerson(req,res,v.data.personId); if(!p) return;
  const map:any={door_ring:'Front door',door_left_open:'Front door',tv_on:'Living-room TV',tv_prolonged:'Living-room TV',fan_changed:'Fan'};
  const d=map[v.data.type]?db.prepare('SELECT id FROM devices WHERE person_id=? AND label=?').get(p.id,map[v.data.type]) as any:null;
  const event={id:randomUUID(),person_id:p.id,device_id:d?.id||null,type:v.data.type,provenance:'simulated',detail:JSON.stringify(v.data.detail||{}),at:new Date().toISOString()};
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(event.id,event.person_id,event.device_id,event.type,event.provenance,event.detail,event.at); log(p.id,'simulated_event',v.data.type); ok(res,event);
});
app.post('/api/sim/clock', (req,res) => ok(res,{now:new Date().toISOString(),note:'Clock simulation is recorded as demo data.'}));
app.post('/api/sim/reset', (_req,res) => { db.prepare('DELETE FROM responses').run(); db.prepare('DELETE FROM requests').run(); db.prepare('DELETE FROM checkins').run(); db.prepare('DELETE FROM events').run(); seed(); const now=Date.now(); db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),'asha','asha-device-1','door_ring','simulated','{}',new Date(now-18*60000).toISOString()); db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(randomUUID(),'asha','asha-device-2','tv_on','simulated','{"durationMinutes":12}',new Date(now-12*60000).toISOString()); ok(res,{reset:true}); });
app.post('/api/people/:id/requests', (req,res) => {
  const p=safePerson(req,res,req.params.id); if(!p)return;
  const v=z.object({kind:requestKind}).strict().safeParse(req.body); if(!v.success)return fail(res,400,'VALIDATION_FAILED','Choose a request.');
  const phrases:any={water:'I need water',food:'I need food',pain:'I am in pain',help:'I need help',toilet:'I need the toilet',rest:'I need to rest',music:'I would like music',call_family:'I would like to call family'};
  const row={id:randomUUID(),person_id:p.id,kind:v.data.kind,phrase:phrases[v.data.kind],at:new Date().toISOString()}; db.prepare('INSERT INTO requests VALUES(?,?,?,?,?,NULL)').run(row.id,row.person_id,row.kind,row.phrase,row.at); log(p.id,'picture_request',row.kind); ok(res,row);
});
app.get('/api/people/:id/requests', (req,res) => { const p=safePerson(req,res,req.params.id); if(p) ok(res,db.prepare('SELECT * FROM requests WHERE person_id=? AND undone_at IS NULL ORDER BY at DESC').all(p.id)); });
app.post('/api/requests/:id/undo', (req,res) => { const row=db.prepare('SELECT * FROM requests WHERE id=?').get(req.params.id) as any; if(!row)return fail(res,404,'NOT_FOUND','Request not found.'); if(Date.now()-Date.parse(row.at)>8000)return fail(res,409,'RULE_BLOCKED','The undo period has ended.'); db.prepare('UPDATE requests SET undone_at=? WHERE id=?').run(new Date().toISOString(),row.id); ok(res,{undone:true}); });
app.post('/api/people/:id/checkins', (req,res) => { const p=safePerson(req,res,req.params.id); if(!p)return; const v=z.object({reason:z.string().min(1).max(300)}).strict().safeParse(req.body); if(!v.success)return fail(res,400,'VALIDATION_FAILED','Add a short reason.'); const c={id:randomUUID(),person_id:p.id,reason:v.data.reason,origin:'person',state:'open',at:new Date().toISOString()}; db.prepare('INSERT INTO checkins VALUES(?,?,?,?,?,?,?)').run(c.id,c.person_id,c.reason,c.origin,c.state,c.at); log(p.id,'checkin_requested',c.reason); ok(res,c); });
app.get('/api/people/:id/checkins', (req,res) => { const p=safePerson(req,res,req.params.id); if(p)ok(res,db.prepare('SELECT * FROM checkins WHERE person_id=? ORDER BY at DESC').all(p.id)); });
app.patch('/api/checkins/:id', (req,res) => { const v=z.object({state:z.enum(['seen','resolved'])}).strict().safeParse(req.body); if(!v.success)return fail(res,400,'VALIDATION_FAILED','Choose seen or resolved.'); const c=db.prepare('SELECT * FROM checkins WHERE id=?').get(req.params.id) as any; if(!c)return fail(res,404,'NOT_FOUND','Check-in not found.'); db.prepare('UPDATE checkins SET state=? WHERE id=?').run(v.data.state,c.id); ok(res,{...c,state:v.data.state}); });
app.get('/api/people/:id/care/summary', (req,res) => { const p=safePerson(req,res,req.params.id); if(!p)return; const missed=activities(p.id).filter(a=>a.state==='not_answered'); const checkins=db.prepare("SELECT * FROM checkins WHERE person_id=? AND state!='resolved' ORDER BY at DESC").all(p.id); ok(res,{needsReview:[...missed,...checkins],counts:{missed:missed.length,checkins:checkins.length}}); });
app.get('/api/people/:id/care/timeline', (req,res) => { const p=safePerson(req,res,req.params.id); if(!p)return; const ev=db.prepare('SELECT id,at,type,provenance,detail FROM events WHERE person_id=? ORDER BY at DESC').all(p.id) as any[]; const rs=db.prepare('SELECT r.id,r.at,r.kind,a.title FROM responses r JOIN activities a ON a.id=r.activity_id WHERE a.person_id=? ORDER BY r.at DESC').all(p.id) as any[]; const requests=db.prepare('SELECT id,at,phrase,kind FROM requests WHERE person_id=? AND undone_at IS NULL ORDER BY at DESC').all(p.id) as any[]; ok(res,[...ev.map(e=>({...e,kind:'event',title:e.type.replaceAll('_',' '),status:e.provenance})),...rs.map(r=>({...r,kind:'reminder',status:r.kind==='acknowledged'?'acknowledged':'not acknowledged'})),...requests.map(r=>({...r,kind:'request',title:r.phrase,status:'open'}))].sort((a:any,b:any)=>b.at.localeCompare(a.at))); });

// The mock provider is deterministic and offline-capable. Bedrock is enabled server-side by configuration.
app.post('/api/people/:id/assistant', async (req,res) => {
  const p=safePerson(req,res,req.params.id); if(!p)return;
  const v=z.object({message:z.string().min(1).max(500)}).strict().safeParse(req.body); if(!v.success)return fail(res,400,'VALIDATION_FAILED','Enter a message of up to 500 characters.');
  const message=v.data.message.toLowerCase(); const calls:any[]=[]; let reply='I can help with today’s routine, recorded home events, or a caregiver check-in.';
  if(/next|routine|plan|schedule/.test(message)){const data=activities(p.id);calls.push({name:'get_daily_routine',input:{},output:data,ok:true,durationMs:1});const next=data.find(a=>a.state==='upcoming');reply=next?`The next planned item is ${next.title} at ${next.time}.`:'There are no upcoming items in today’s plan.';}
  if(/door|event|tv|home|device/.test(message)){const data=db.prepare('SELECT type,provenance,at FROM events WHERE person_id=? ORDER BY at DESC LIMIT 10').all(p.id);calls.push({name:'get_home_events',input:{limit:10},output:data,ok:true,durationMs:1});reply=data.length?`The latest recorded home event is ${String((data[0] as any).type).replaceAll('_',' ')} (simulated).`:'No home events are recorded. That does not mean nothing happened.';}
  if(/help|check.?in|caregiver|family/.test(message)){const c={id:randomUUID(),person_id:p.id,reason:v.data.message,origin:'assistant',state:'open',at:new Date().toISOString()}; db.prepare('INSERT INTO checkins VALUES(?,?,?,?,?,?,?)').run(c.id,c.person_id,c.reason,c.origin,c.state,c.at);calls.push({name:'request_caregiver_checkin',input:{reason:v.data.message},output:c,ok:true,durationMs:1});reply='I asked your Care Circle to check in.';}
  const blocked=/\bsafe\b|\beverything is fine\b|\b(taken your medicine|medicine taken)\b/i; if(blocked.test(reply))reply='I cannot confirm that. You can ask your Care Circle to check in.';
  ok(res,{messageId:randomUUID(),text:reply,toolCalls:calls});
});
app.get('/api/people/:id/assistant/history', (_req,res) => ok(res,[]));
app.use('/api',(_req,res) => fail(res,404,'NOT_FOUND','This page could not be found.'));
app.use(express.static(resolve(process.cwd(),'../client/dist')));
app.get('*',(_req,res) => res.sendFile(resolve(process.cwd(),'../client/dist/index.html')));
const port=Number(process.env.PORT||3001); app.listen(port,'127.0.0.1',()=>console.log(`NEST API listening on 127.0.0.1:${port}`));
