import type { Storage } from './storage.js';

const migrations = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_mode TEXT NOT NULL DEFAULT 'visual',text_scale DOUBLE PRECISION NOT NULL DEFAULT 1,dementia_mode INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS activities(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,instruction TEXT NOT NULL,time TEXT NOT NULL,allow_postpone INTEGER NOT NULL DEFAULT 1,approved INTEGER NOT NULL DEFAULT 1)`,
      `CREATE TABLE IF NOT EXISTS responses(id TEXT PRIMARY KEY,activity_id TEXT NOT NULL,kind TEXT NOT NULL,channel TEXT NOT NULL,at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,label TEXT NOT NULL,state TEXT,last_reported_at TEXT)`,
      `CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,device_id TEXT,type TEXT NOT NULL,provenance TEXT NOT NULL,detail TEXT,at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,kind TEXT NOT NULL,phrase TEXT NOT NULL,at TEXT NOT NULL,undone_at TEXT)`,
      `CREATE TABLE IF NOT EXISTS checkins(id TEXT PRIMARY KEY,person_id TEXT NOT NULL,reason TEXT NOT NULL,origin TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'open',at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,person_id TEXT,action TEXT NOT NULL,detail TEXT,at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ring_webhook_receipts(request_id TEXT PRIMARY KEY,received_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ring_oauth_tokens(account_key TEXT PRIMARY KEY,account_id_enc TEXT NOT NULL,access_token_enc TEXT NOT NULL,refresh_token_enc TEXT NOT NULL,expires_at BIGINT NOT NULL,state TEXT NOT NULL DEFAULT 'connected',link_state TEXT NOT NULL DEFAULT 'linked',version INTEGER NOT NULL DEFAULT 1,refresh_owner TEXT,refresh_lease_until BIGINT,updated_at BIGINT NOT NULL DEFAULT 0)`,
      `CREATE INDEX IF NOT EXISTS ring_oauth_state_idx ON ring_oauth_tokens(state)`,
      `CREATE INDEX IF NOT EXISTS activities_person_time_idx ON activities(person_id,time)`,
      `CREATE INDEX IF NOT EXISTS events_person_at_idx ON events(person_id,at DESC)`,
      `CREATE INDEX IF NOT EXISTS requests_person_at_idx ON requests(person_id,at DESC)`,
      `CREATE INDEX IF NOT EXISTS checkins_person_at_idx ON checkins(person_id,at DESC)`
    ]
  },
  { version: 2, statements: [] }
];

export async function migrateStorage(storage: Storage): Promise<void> {
  await storage.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set((await storage.prepare('SELECT version FROM schema_migrations').all()).map(row => Number(row.version)));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    for (const statement of migration.statements) await storage.exec(statement);
    if (migration.version === 2) {
      if (storage.dialect === 'postgres') {
        await storage.exec('ALTER TABLE ring_oauth_tokens ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0');
      } else {
        const columns = await storage.prepare('PRAGMA table_info(ring_oauth_tokens)').all();
        if (columns.length && !columns.some(column => column.name === 'updated_at')) await storage.exec('ALTER TABLE ring_oauth_tokens ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0');
      }
    }
    await storage.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?) ON CONFLICT(version) DO NOTHING').run(migration.version, new Date().toISOString());
  }
}
