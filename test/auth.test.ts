import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmdirSync, unlinkSync, mkdtempSync } from 'node:fs'

import { AppError } from '../src/errors/index.js'
import { openDatabase } from '../src/storage/index.js'
import {
  login,
  logout,
  authenticate,
  resetPassword,
  isPasswordConfigured,
} from '../src/auth/index.js'

test('password must be initialized with the reset command', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())

  assert.equal(isPasswordConfigured(db), false)
  await assert.rejects(login(db, 'anything'), error => {
    assert.ok(error instanceof AppError)
    assert.equal(error.statusCode, 503)
    return true
  })
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
  await assert.rejects(login(db, 'wrong-password'), error => {
    assert.ok(error instanceof AppError)
    assert.equal(error.statusCode, 401)
    return true
  })

  const session = await login(db, password)
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
  const session = await login(db, password)
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
  const session = await login(db, oldPassword)
  const newPassword = await resetPassword(db)

  assert.notEqual(newPassword, oldPassword)
  assert.equal(authenticate(db, session.token), false)
  await assert.rejects(login(db, oldPassword))
  assert.equal(authenticate(db, (await login(db, newPassword)).token), true)
})

test('a password change during verification cannot issue an old session', async t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const password = await resetPassword(db)
  const pendingLogin = login(db, password)
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
  const oldSession = await login(serverDb, oldPassword)
  const newPassword = await resetPassword(commandDb)

  assert.equal(authenticate(serverDb, oldSession.token), false)
  await assert.rejects(login(serverDb, oldPassword))
  assert.equal(
    authenticate(serverDb, (await login(serverDb, newPassword)).token),
    true,
  )
})
