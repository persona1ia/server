import { test } from 'node:test'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { TestContext } from 'node:test'
import { rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'

import { transaction, openDatabase } from '../src/storage/index.js'
import { listOrders, simulateCheckout } from '../src/orders/index.js'
import { getMedia, listMedia, storeImage } from '../src/media/index.js'
import {
  getCurrent,
  getRevision,
  saveContent,
  listRevisions,
  initializeContent,
} from '../src/content/index.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=',
  'base64',
)

const course = {
  id: 'intro',
  imageId: null,
  visible: true,
  currency: 'RUB',
  description: '',
  priceMinor: 3500,
  title: 'Тестовый курс',
}

function temporaryDatabasePath(t: TestContext): string {
  const temporaryRoot = resolve(tmpdir())
  const directory = mkdtempSync(join(temporaryRoot, 'persona1ia-storage-'))
  t.after(() => {
    const target = resolve(directory)
    assert.equal(dirname(target), temporaryRoot)
    assert.ok(basename(target).startsWith('persona1ia-storage-'))
    rmSync(target, { force: true, recursive: true })
  })
  return join(directory, 'server.sqlite')
}

test('reopening a file database preserves content, history, images and idempotent orders', t => {
  const path = temporaryDatabasePath(t)
  let db = openDatabase(path)
  try {
    initializeContent(db)
    const initial = getCurrent(db)
    const image = storeImage(db, png, 'image/png')
    const saved = saveContent(db, {
      baseRevision: initial.revision,
      content: {
        ...initial.content,
        courses: [{ ...course, imageId: image.id }],
      },
    })
    const checkout = { courseId: course.id, idempotencyKey: randomUUID() }
    const order = simulateCheckout(db, checkout)

    db.close()
    db = openDatabase(path)
    initializeContent(db)

    assert.deepEqual(getCurrent(db), saved)
    assert.deepEqual(getRevision(db, initial.revision), initial)
    assert.deepEqual(getMedia(db, image.id), { data: png, item: image })
    assert.deepEqual(
      listOrders(db).map(item => ({ ...item })),
      [order],
    )
    assert.deepEqual({ ...simulateCheckout(db, checkout) }, order)
    assert.equal(listOrders(db).length, 1)
  } finally {
    if (db.isOpen) {
      db.close()
    }
  }
})

test('rejecting a newer database schema leaves its file and data unchanged', t => {
  const path = temporaryDatabasePath(t)
  const futureDatabase = new DatabaseSync(path)
  try {
    futureDatabase.exec(`
      CREATE TABLE future_content (message TEXT NOT NULL);
      INSERT INTO future_content (message) VALUES ('Future application data');
      PRAGMA user_version = 2;
    `)
  } finally {
    futureDatabase.close()
  }

  const originalBytes = readFileSync(path)
  assert.throws(() => openDatabase(path), /Unsupported database version: 2/)
  assert.deepEqual(readFileSync(path), originalBytes)

  const unchangedDatabase = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(
      unchangedDatabase.prepare('PRAGMA user_version').get()?.user_version,
      2,
    )
    assert.equal(
      unchangedDatabase.prepare('SELECT message FROM future_content').get()
        ?.message,
      'Future application data',
    )
    assert.equal(
      unchangedDatabase
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'",
        )
        .get()?.count,
      1,
    )
  } finally {
    unchangedDatabase.close()
  }
})

test('a caught inner failure rolls back its writes and the outer transaction can continue', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  initializeContent(db)
  const initial = getCurrent(db)
  const failure = new Error('Cancel only the inner operation')

  const committed = transaction(db, () => {
    const beforeInner = saveContent(db, {
      baseRevision: initial.revision,
      content: {
        ...initial.content,
        site: { ...initial.content.site, title: 'Outer change' },
      },
    })
    assert.throws(
      () =>
        transaction(db, () => {
          const image = storeImage(db, png, 'image/png')
          saveContent(db, {
            baseRevision: beforeInner.revision,
            content: {
              ...beforeInner.content,
              courses: [{ ...course, imageId: image.id }],
            },
          })
          throw failure
        }),
      failure,
    )

    assert.deepEqual(getCurrent(db), beforeInner)
    assert.deepEqual(listMedia(db), [])
    return saveContent(db, {
      baseRevision: beforeInner.revision,
      content: {
        ...beforeInner.content,
        site: { ...beforeInner.content.site, description: 'Still committed' },
      },
    })
  })

  assert.deepEqual(getCurrent(db), committed)
  assert.equal(getCurrent(db).content.site.title, 'Outer change')
  assert.equal(listRevisions(db).length, 3)
  assert.deepEqual(listMedia(db), [])
})

test('an outer failure rolls back successful nested content, media and order operations', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  initializeContent(db)
  const initial = getCurrent(db)
  const failure = new Error('Cancel the entire operation')

  assert.throws(
    () =>
      transaction(db, () => {
        const image = storeImage(db, png, 'image/png')
        saveContent(db, {
          baseRevision: initial.revision,
          content: {
            ...initial.content,
            courses: [{ ...course, imageId: image.id }],
          },
        })
        simulateCheckout(db, {
          courseId: course.id,
          idempotencyKey: randomUUID(),
        })
        throw failure
      }),
    failure,
  )

  assert.deepEqual(getCurrent(db), initial)
  assert.equal(listRevisions(db).length, 1)
  assert.deepEqual(listMedia(db), [])
  assert.deepEqual(listOrders(db), [])
})
