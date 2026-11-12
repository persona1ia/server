import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmdirSync, unlinkSync, mkdtempSync } from 'node:fs'

import { ZodError } from 'zod'

import { AppError } from '../src/errors/index.js'
import { openDatabase } from '../src/storage/index.js'
import {
  login,
  logout,
  authenticate,
  resetPassword,
  changePassword,
  isPasswordConfigured,
} from '../src/auth/index.js'

test('password must be initialized with the reset command', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())

  assert.equal(isPasswordConfigured(db), false)
  await assert.rejects(login(db, { password: 'anything' }), error => {
    assert.ok(error instanceof AppError)
    assert.equal(error.statusCode, 503)
    return true
  })
})

test('login validates credentials before creating a session', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const password = await resetPassword(db)

  for (const input of [
    undefined,
    password,
    {},
    { password: '' },
    { password: 123 },
    { password: 'a'.repeat(1025) },
    { password, unexpected: true },
  ]) {
    await assert.rejects(login(db, input), ZodError)
  }

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count,
    0,
  )
  assert.equal(authenticate(db, (await login(db, { password })).token), true)
})

test('login stores only a token hash and logout invalidates the session', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const password = await resetPassword(db)

  assert.equal(isPasswordConfigured(db), true)
  assert.match(password, /^[A-Za-z0-9_-]{32}$/)
  assert.notEqual(
    db.prepare('SELECT hash FROM admin_password WHERE id = 1').get()?.hash,
    password,
  )
  await assert.rejects(login(db, { password: 'wrong-password' }), error => {
    assert.ok(error instanceof AppError)
    assert.equal(error.statusCode, 401)
    return true
  })

  const session = await login(db, { password })
  assert.equal(authenticate(db, session.token), true)
  assert.notEqual(
    db.prepare('SELECT token_hash FROM sessions').get()?.token_hash,
    session.token,
  )
  assert.equal(authenticate(db, undefined), false)
  assert.equal(authenticate(db, 'invalid-token'), false)
  logout(db, session.token)
  assert.equal(authenticate(db, session.token), false)
})

test('expired sessions cannot authenticate', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const password = await resetPassword(db)
  const session = await login(db, { password })
  db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1)

  assert.equal(authenticate(db, session.token), false)
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count,
    0,
  )
})

test('resetting the password revokes old sessions and old credentials', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const oldPassword = await resetPassword(db)
  const session = await login(db, { password: oldPassword })
  const newPassword = await resetPassword(db)

  assert.notEqual(newPassword, oldPassword)
  assert.equal(authenticate(db, session.token), false)
  await assert.rejects(login(db, { password: oldPassword }))
  assert.equal(
    authenticate(db, (await login(db, { password: newPassword })).token),
    true,
  )
})

test('a password change during verification cannot issue an old session', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const password = await resetPassword(db)
  const pendingLogin = login(db, { password })
  db.prepare('UPDATE admin_password SET hash = ? WHERE id = 1').run('changed')

  await assert.rejects(pendingLogin, error => {
    assert.ok(error instanceof AppError)
    assert.equal(error.statusCode, 401)
    return true
  })
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count,
    0,
  )
})

test('a separate connection can reset the password without restarting the server', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'persona1ia-auth-'))
  const path = join(directory, 'server.sqlite')
  const serverDb = openDatabase(path)
  const commandDb = openDatabase(path)
  t.after(() => {
    serverDb.close()
    commandDb.close()
    unlinkSync(path)
    rmdirSync(directory)
  })
  const oldPassword = await resetPassword(commandDb)
  const oldSession = await login(serverDb, { password: oldPassword })
  const newPassword = await resetPassword(commandDb)

  assert.equal(authenticate(serverDb, oldSession.token), false)
  await assert.rejects(login(serverDb, { password: oldPassword }))
  assert.equal(
    authenticate(
      serverDb,
      (await login(serverDb, { password: newPassword })).token,
    ),
    true,
  )
})

test('changing the password revokes every old session and preserves the chosen password exactly', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const oldPassword = await resetPassword(db)
  const first = await login(db, { password: oldPassword })
  const second = await login(db, { password: oldPassword })
  const newPassword = '  chosen password with spaces  '

  const session = await changePassword(db, {
    newPassword,
    currentPassword: oldPassword,
  })

  assert.equal(authenticate(db, first.token), false)
  assert.equal(authenticate(db, second.token), false)
  assert.equal(authenticate(db, session.token), true)
  assert.ok(session.expiresAt > Date.now())
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM sessions').get()?.count,
    1,
  )
  await assert.rejects(login(db, { password: oldPassword }), {
    statusCode: 401,
  })
  await assert.rejects(login(db, { password: newPassword.trim() }), {
    statusCode: 401,
  })
  assert.equal(
    authenticate(db, (await login(db, { password: newPassword })).token),
    true,
  )
})

test('an incorrect current password leaves the password and sessions unchanged', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const password = await resetPassword(db)
  const session = await login(db, { password })
  const previousPassword = db.prepare('SELECT * FROM admin_password').get()
  const previousSessions = db.prepare('SELECT * FROM sessions').all()

  await assert.rejects(
    changePassword(db, {
      newPassword: 'chosen-new-password',
      currentPassword: 'incorrect-password',
    }),
    { statusCode: 401 },
  )

  assert.deepEqual(
    db.prepare('SELECT * FROM admin_password').get(),
    previousPassword,
  )
  assert.deepEqual(db.prepare('SELECT * FROM sessions').all(), previousSessions)
  assert.equal(authenticate(db, session.token), true)
  assert.equal(authenticate(db, (await login(db, { password })).token), true)
})

test('a concurrent password change is not overwritten and does not delete existing sessions', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const password = await resetPassword(db)
  const session = await login(db, { password })
  const previousSessions = db.prepare('SELECT * FROM sessions').all()
  const pendingChange = changePassword(db, {
    currentPassword: password,
    newPassword: 'pending-new-password',
  })
  db.prepare('UPDATE admin_password SET hash = ? WHERE id = 1').run(
    'concurrent-change',
  )

  await assert.rejects(pendingChange, { statusCode: 409 })
  assert.equal(
    db.prepare('SELECT hash FROM admin_password WHERE id = 1').get()?.hash,
    'concurrent-change',
  )
  assert.deepEqual(db.prepare('SELECT * FROM sessions').all(), previousSessions)
  assert.equal(authenticate(db, session.token), true)
})

test('a failed password reset preserves the previous password and sessions', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const password = await resetPassword(db)
  const session = await login(db, { password })
  const previousPassword = db.prepare('SELECT * FROM admin_password').get()
  const previousSessions = db.prepare('SELECT * FROM sessions').all()
  db.exec(`
    CREATE TRIGGER fail_session_delete BEFORE DELETE ON sessions
    BEGIN SELECT RAISE(ABORT, 'session deletion failed'); END;
  `)

  await assert.rejects(resetPassword(db), /session deletion failed/)

  assert.deepEqual(
    db.prepare('SELECT * FROM admin_password').get(),
    previousPassword,
  )
  assert.deepEqual(db.prepare('SELECT * FROM sessions').all(), previousSessions)
  assert.equal(authenticate(db, session.token), true)
})

test('a failed replacement session rolls back the complete password change', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const password = await resetPassword(db)
  const session = await login(db, { password })
  const previousPassword = db.prepare('SELECT * FROM admin_password').get()
  const previousSessions = db.prepare('SELECT * FROM sessions').all()
  db.exec(`
    CREATE TRIGGER fail_session_insert BEFORE INSERT ON sessions
    BEGIN SELECT RAISE(ABORT, 'session creation failed'); END;
  `)

  await assert.rejects(
    changePassword(db, {
      currentPassword: password,
      newPassword: 'chosen-new-password',
    }),
    /session creation failed/,
  )

  assert.deepEqual(
    db.prepare('SELECT * FROM admin_password').get(),
    previousPassword,
  )
  assert.deepEqual(db.prepare('SELECT * FROM sessions').all(), previousSessions)
  assert.equal(authenticate(db, session.token), true)
})
