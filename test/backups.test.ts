import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openDatabase } from '../src/storage/index.js'
import { createBackup, restoreBackup } from '../src/backups/index.js'
import { getMedia, listMedia, storeImage } from '../src/media/index.js'
import {
  getCurrent,
  saveContent,
  listRevisions,
  initializeContent,
} from '../src/content/index.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=',
  'base64',
)
const gif = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64',
)

function createSource() {
  const db = openDatabase(':memory:')
  initializeContent(db)
  const image = storeImage(db, png, 'image/png')
  const current = getCurrent(db)
  const content = current.content
  content.courses.push({
    title: 'Курс',
    visible: true,
    currency: 'RUB',
    id: 'test-course',
    priceMinor: 15000,
    imageId: image.id,
    description: 'Описание курса',
  })
  const saved = saveContent(db, { content, baseRevision: current.revision })
  return { db, image, saved }
}

test('a downloaded backup restores content and referenced images into a fresh database', t => {
  const source = createSource()
  const target = openDatabase(':memory:')
  t.after(() => source.db.close())
  t.after(() => target.close())
  initializeContent(target)
  storeImage(source.db, gif, 'image/gif')

  const backup = createBackup(source.db)
  assert.equal(backup.media.length, 1)
  assert.deepEqual(Object.keys(backup).sort(), [
    'content',
    'exportedAt',
    'format',
    'media',
    'version',
  ])
  const saved = restoreBackup(target, {
    baseRevision: getCurrent(target).revision,
    backup: JSON.parse(JSON.stringify(backup)),
  })
  assert.deepEqual(saved.content, source.saved.content)
  assert.deepEqual(getMedia(target, source.image.id).data, png)
  assert.equal(listRevisions(target).length, 2)
})

test('corrupt, missing, duplicated or extra backup media leave storage unchanged', t => {
  const source = createSource()
  const target = openDatabase(':memory:')
  t.after(() => source.db.close())
  t.after(() => target.close())
  initializeContent(target)
  const original = createBackup(source.db)
  const first = original.media[0]
  assert.ok(first)
  const corrupt = structuredClone(original)
  corrupt.media = [{ ...first, dataBase64: gif.toString('base64') }]
  const missing = { ...original, media: [] }
  const duplicate = { ...original, media: [first, first] }
  const extra = {
    ...original,
    media: [first, { ...first, id: 'a'.repeat(64) }],
  }
  const noncanonical = {
    ...original,
    media: [{ ...first, dataBase64: `${first.dataBase64}\n` }],
  }

  const current = getCurrent(target)
  for (const backup of [corrupt, missing, duplicate, extra, noncanonical]) {
    assert.throws(() =>
      restoreBackup(target, { backup, baseRevision: current.revision }),
    )
    assert.deepEqual(getCurrent(target), current)
    assert.deepEqual(listMedia(target), [])
    assert.equal(listRevisions(target).length, 1)
  }
})

test('a failed revision write rolls back images imported by the same backup', t => {
  const source = createSource()
  const target = openDatabase(':memory:')
  t.after(() => source.db.close())
  t.after(() => target.close())
  initializeContent(target)
  const current = getCurrent(target)
  target.exec(`CREATE TEMP TRIGGER reject_revision BEFORE INSERT ON revisions
    BEGIN SELECT RAISE(ABORT, 'Simulated disk write failure'); END`)

  assert.throws(() =>
    restoreBackup(target, {
      baseRevision: current.revision,
      backup: createBackup(source.db),
    }),
  )
  assert.deepEqual(listMedia(target), [])
  assert.deepEqual(getCurrent(target), current)
})

test('restore rejects a stale base revision without replacing newer changes', t => {
  const source = createSource()
  t.after(() => source.db.close())
  const backup = createBackup(source.db)
  const newer = saveContent(source.db, {
    content: source.saved.content,
    baseRevision: source.saved.revision,
  })

  assert.throws(
    () =>
      restoreBackup(source.db, {
        backup,
        baseRevision: source.saved.revision,
      }),
    { statusCode: 409 },
  )
  assert.deepEqual(getCurrent(source.db), newer)
})

test('exporting an older revision includes its original images after current content changes', t => {
  const source = createSource()
  t.after(() => source.db.close())
  const content = structuredClone(source.saved.content)
  content.courses = []
  saveContent(source.db, { content, baseRevision: source.saved.revision })

  assert.deepEqual(createBackup(source.db).media, [])
  const historical = createBackup(source.db, source.saved.revision)
  assert.deepEqual(historical.content, source.saved.content)
  assert.equal(historical.media[0]?.id, source.image.id)
  assert.equal(historical.media[0]?.dataBase64, png.toString('base64'))
})
