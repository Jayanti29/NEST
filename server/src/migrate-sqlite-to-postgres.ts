import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrateStorage } from './migrations.js';
import { openStorage, type Storage } from './storage.js';

const primaryKeys: Record<string, string> = {
  people: 'id', activities: 'id', responses: 'id', devices: 'id', events: 'id',
  requests: 'id', checkins: 'id', audit: 'id', ring_webhook_receipts: 'request_id', ring_oauth_tokens: 'account_key'
};

export async function migrateSqliteToPostgres(sourcePath: string, target: Storage): Promise<Record<string, number>> {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await migrateStorage(target);
    const counts: Record<string, number> = {};
    for (const [table, key] of Object.entries(primaryKeys)) {
      const columns = (source.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(column => column.name);
      if (!columns.length) continue;
      const rows = source.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
      counts[table] = rows.length;
      const safeColumns = columns.filter(column => /^[a-z_][a-z0-9_]*$/.test(column));
      if (!safeColumns.includes(key)) throw new Error(`The local ${table} table is missing its expected key.`);
      const assignments = safeColumns.filter(column => column !== key).map(column => `"${column}"=EXCLUDED."${column}"`).join(',');
      const sql = `INSERT INTO "${table}"(${safeColumns.map(column => `"${column}"`).join(',')}) VALUES(${safeColumns.map(() => '?').join(',')}) ON CONFLICT("${key}") DO ${assignments ? `UPDATE SET ${assignments}` : 'NOTHING'}`;
      const insert = target.prepare(sql);
      for (const row of rows) await insert.run(...safeColumns.map(column => row[column]));
    }
    return counts;
  } finally {
    source.close();
  }
}

async function main() {
  const sourcePath = resolve(process.env.NEST_SOURCE_DB_PATH || 'server/nest.sqlite');
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the durable target database before migrating.');
  if (!existsSync(sourcePath)) throw new Error('The local SQLite database was not found.');
  const target = await openStorage();
  try {
    const counts = await migrateSqliteToPostgres(sourcePath, target);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    console.log(`Copied ${total} rows from the local database into durable storage. The source file was kept unchanged.`);
  } finally {
    await target.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    console.error('Database migration failed. No source database was modified; rerun after correcting the target configuration.');
    process.exitCode = 1;
  });
}
