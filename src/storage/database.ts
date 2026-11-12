import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, resolve } from 'node:path'

let savepointSequence = 0

export function openDatabase(path = resolve('data/server.sqlite')) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true })
  }

  const db = new DatabaseSync(path, { timeout: 5000 })
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== 1) {
      throw new Error(`Unsupported database version: ${String(version)}`)
    }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    if (version === 0) {
      transaction(db, () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS admin_password (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            hash TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            expires_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            document TEXT NOT NULL CHECK (json_valid(document))
          );
          CREATE TABLE IF NOT EXISTS media (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind = 'image'),
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL CHECK (size > 0),
            created_at TEXT NOT NULL,
            data BLOB NOT NULL CHECK (length(data) = size)
          );
          CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            course_id TEXT NOT NULL,
            course_title TEXT NOT NULL,
            price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
            currency TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status = 'simulated_paid'),
            created_at TEXT NOT NULL
          );
          PRAGMA user_version = 1;
        `)
      })
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  const savepoint = db.isTransaction ? `nested_${++savepointSequence}` : null
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
  try {
    const result = action()
    db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT')
    return result
  } catch (error) {
    db.exec(
      savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK',
    )
    throw error
  }
}
