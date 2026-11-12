import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AppError } from '../src/errors/index.js'
import { openDatabase } from '../src/storage/index.js'
import {
  getMedia,
  listMedia,
  storeImage,
  deleteMedia,
  validateImage,
  MAX_IMAGE_BYTES,
} from '../src/media/index.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=',
  'base64',
)
const gif = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64',
)
const jpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==',
  'base64',
)

test('real PNG, GIF and JPEG images pass their basic structure checks', () => {
  validateImage(png, 'image/png')
  validateImage(gif, 'image/gif')
  validateImage(jpeg, 'image/jpeg')
})

test('image signatures alone and truncated image data are rejected', () => {
  assert.throws(
    () => validateImage(Buffer.from('ffd8ffe0', 'hex'), 'image/jpeg'),
    { statusCode: 415 },
  )
  assert.throws(() => validateImage(png.subarray(0, 33), 'image/png'), {
    statusCode: 415,
  })
  for (const [data, mime] of [
    [png, 'image/png'],
    [gif, 'image/gif'],
    [jpeg, 'image/jpeg'],
  ] as const) {
    assert.throws(() => validateImage(data.subarray(0, -4), mime), {
      statusCode: 415,
    })
  }
})

test('uploading the same image preserves its identity and stored bytes', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())

  const first = storeImage(db, png, 'image/png')
  const second = storeImage(db, png, 'image/png')
  assert.deepEqual(second, first)
  assert.deepEqual(getMedia(db, first.id).data, png)
  assert.equal(first.size, png.length)
  assert.equal(first.url, `/api/media/${first.id}`)
  assert.equal(listMedia(db).length, 1)
})

test('images must match their declared type and cannot exceed the size limit', () => {
  assert.throws(() => validateImage(png, 'image/jpeg'), {
    statusCode: 415,
  })
  assert.throws(() => validateImage(Buffer.from('<svg/>'), 'image/svg+xml'), {
    statusCode: 415,
  })
  assert.throws(() => validateImage(Buffer.alloc(0), 'image/png'), {
    statusCode: 415,
  })
  assert.throws(
    () => validateImage(Buffer.alloc(MAX_IMAGE_BYTES + 1), 'image/png'),
    { statusCode: 413 },
  )
})

test('all historical revisions protect their referenced media from deletion', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const image = storeImage(db, png, 'image/png')
  const save = db.prepare(
    'INSERT INTO revisions (created_at, document) VALUES (?, ?)',
  )
  save.run(new Date().toISOString(), JSON.stringify({ imageId: image.id }))
  save.run(new Date().toISOString(), JSON.stringify({ imageId: null }))

  assert.throws(() => deleteMedia(db, image.id), {
    statusCode: 409,
    code: 'MEDIA_IN_USE',
  })
  assert.deepEqual(getMedia(db, image.id).data, png)
})

test('unreferenced images can be deleted and no longer read', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const image = storeImage(db, png, 'image/png')
  deleteMedia(db, image.id)
  assert.deepEqual(listMedia(db), [])
  assert.throws(() => getMedia(db, image.id), AppError)
  assert.throws(() => deleteMedia(db, image.id), { statusCode: 404 })
})

test('pagination rejects invalid values', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  assert.throws(() => listMedia(db, 0), { statusCode: 400 })
  assert.throws(() => listMedia(db, 101), { statusCode: 400 })
  assert.throws(() => listMedia(db, 20, -1), { statusCode: 400 })
})
