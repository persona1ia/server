import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'

import { AppError } from '../errors/index.js'
import { transaction } from '../storage/index.js'
import { hashPassword, verifyPassword } from './password.js'
import type { SessionRow, AuthSession, PasswordRow } from './types.js'

const sessionDuration = 7 * 24 * 60 * 60 * 1000

function getPasswordHash(db: DatabaseSync): string | undefined {
  const row = db
    .prepare('SELECT hash FROM admin_password WHERE id = 1')
    .get() as PasswordRow | undefined
  return row?.hash
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function invalidCredentials(): AppError {
  return new AppError(401, 'invalid_credentials', 'Неверный пароль.')
}

export function isPasswordConfigured(db: DatabaseSync): boolean {
  return getPasswordHash(db) !== undefined
}

export async function resetPassword(db: DatabaseSync): Promise<string> {
  const password = randomBytes(24).toString('base64url')
  const hash = await hashPassword(password)

  transaction(db, () => {
    db.prepare(
      'INSERT INTO admin_password (id, hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash',
    ).run(hash)
    db.prepare('DELETE FROM sessions').run()
  })

  return password
}

export async function login(
  db: DatabaseSync,
  password: string,
): Promise<AuthSession> {
  const hash = getPasswordHash(db)

  if (!hash) {
    throw new AppError(
      503,
      'password_not_configured',
      'Пароль администратора ещё не установлен. Выполните команду сброса пароля.',
    )
  }

  if (
    password.length === 0 ||
    password.length > 1024 ||
    !(await verifyPassword(password, hash))
  ) {
    throw invalidCredentials()
  }

  const now = Date.now()
  const token = randomBytes(32).toString('base64url')
  const expiresAt = now + sessionDuration

  transaction(db, () => {
    // A password reset can finish while the asynchronous scrypt call runs.
    if (getPasswordHash(db) !== hash) {
      throw invalidCredentials()
    }

    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
    db.prepare(
      'INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)',
    ).run(hashToken(token), expiresAt)
  })

  return { token, expiresAt }
}

export function authenticate(
  db: DatabaseSync,
  token: string | undefined,
): boolean {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return false
  }

  const tokenHash = hashToken(token)
  const row = db
    .prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash) as SessionRow | undefined

  if (!row) {
    return false
  }

  if (row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    return false
  }

  return true
}

export function logout(db: DatabaseSync, token: string | undefined): void {
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(
      hashToken(token),
    )
  }
}
