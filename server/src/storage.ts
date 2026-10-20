import { DatabaseSync } from 'node:sqlite';
import { existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

export type QueryResult<T = Record<string, unknown>> = { rows: T[]; rowCount: number };
export interface StorageStatement {
  all(...params: unknown[]): Promise<any[]>;
  get(...params: unknown[]): Promise<any>;
  run(...params: unknown[]): Promise<{ changes: number }>;
}
export interface Storage {
  readonly dialect: 'sqlite' | 'postgres';
  readonly nativeRingDatabase?: DatabaseSync;
  exec(sql: string): Promise<void>;
  prepare(sql: string): StorageStatement;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
}

class SqliteStorage implements Storage {
  readonly dialect = 'sqlite' as const;
  readonly nativeRingDatabase: DatabaseSync;
  constructor(native: DatabaseSync) { this.nativeRingDatabase = native; }
  async exec(sql: string) { this.nativeRingDatabase.exec(sql); }
  prepare(sql: string): StorageStatement {
    const statement = this.nativeRingDatabase.prepare(sql);
    return {
      all: async (...params) => statement.all(...params as any[]),
      get: async (...params) => statement.get(...params as any[]),
      run: async (...params) => {
        const result = statement.run(...params as any[]);
        return { changes: Number(result.changes) };
      }
    };
  }
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const statement = this.nativeRingDatabase.prepare(sql);
    if (/^\s*(SELECT|PRAGMA)\b/i.test(sql)) {
      const rows = statement.all(...params as any[]) as T[];
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...params as any[]);
    return { rows: [] as T[], rowCount: Number(result.changes) };
  }
  async close() { this.nativeRingDatabase.close(); }
}

class PostgresStorage implements Storage {
  readonly dialect = 'postgres' as const;
  private readonly pool: import('pg').Pool;
  constructor(pool: import('pg').Pool) { this.pool = pool; }
  async exec(sql: string) { await this.pool.query(sql); }
  prepare(sql: string): StorageStatement {
    const run = async (params: unknown[]) => this.query(sql, params);
    return {
      all: async (...params) => (await run(params)).rows,
      get: async (...params) => (await run(params)).rows[0],
      run: async (...params) => ({ changes: (await run(params)).rowCount })
    };
  }
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    let index = 0;
    const statement = sql.replace(/\?/g, () => `$${++index}`);
    const result = await this.pool.query(statement, params);
    return { rows: result.rows as T[], rowCount: result.rowCount || 0 };
  }
  async close() { await this.pool.end(); }
}

export async function openStorage(): Promise<Storage> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: true } });
    pool.on('error', () => { /* Avoid logging driver errors that may contain connection details. */ });
    try { await pool.query('SELECT 1'); }
    catch {
      await pool.end().catch(() => undefined);
      throw new Error('The durable database connection could not be established.');
    }
    return new PostgresStorage(pool);
  }
  if (process.env.VERCEL) throw new Error('DATABASE_URL is required on Vercel; SQLite is local-development only.');
  const configuredPath = process.env.NEST_DB_PATH || 'nest.sqlite';
  const dbPath = configuredPath === ':memory:' ? configuredPath : resolve(configuredPath);
  const native = new DatabaseSync(dbPath);
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  native.exec('PRAGMA journal_mode = WAL');
  native.exec('PRAGMA secure_delete = ON');
  return new SqliteStorage(native);
}
