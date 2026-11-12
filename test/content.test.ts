import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import type { DatabaseSync } from 'node:sqlite'

import { openDatabase } from '../src/storage/index.js'
import type { SiteContent } from '../src/content/index.js'
import {
  getCurrent,
  getRevision,
  saveContent,
  listRevisions,
  restoreRevision,
  collectMediaIds,
  getPublicContent,
  siteContentSchema,
  initializeContent,
  MAX_CONTENT_MEDIA_BYTES,
} from '../src/content/index.js'

const databases: DatabaseSync[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function createDatabase(): DatabaseSync {
  const db = openDatabase(':memory:')
  databases.push(db)
  initializeContent(db)
  return db
}

function course(id: string, visible = true): SiteContent['courses'][number] {
  return {
    id,
    visible,
    title: id,
    imageId: null,
    description: '',
    currency: 'RUB',
    priceMinor: 12_345,
  }
}

test('initialization is idempotent and creates valid empty content', () => {
  const db = createDatabase()
  initializeContent(db)
  assert.equal(listRevisions(db).length, 1)
  assert.deepEqual(
    siteContentSchema.parse(getCurrent(db).content),
    getCurrent(db).content,
  )
})

test('validation rejects duplicate IDs, dangling references and invalid prices', () => {
  const content = getCurrent(createDatabase()).content
  content.courses = [course('first'), course('first')]
  assert.equal(siteContentSchema.safeParse(content).success, false)

  content.courses = [course('first')]
  const block = {
    title: '',
    id: 'courses',
    visible: true,
    courseIds: ['missing'],
    type: 'courses' as const,
  }
  content.blocks = [block]
  assert.equal(siteContentSchema.safeParse(content).success, false)

  block.courseIds = ['first', 'first']
  assert.equal(siteContentSchema.safeParse(content).success, false)
  block.courseIds = ['first']
  content.blocks = [block, block]
  assert.equal(siteContentSchema.safeParse(content).success, false)

  content.blocks = [block]
  content.courses = [{ ...course('first'), priceMinor: 1.5 }]
  assert.equal(siteContentSchema.safeParse(content).success, false)
  content.courses = [{ ...course('first'), priceMinor: -1 }]
  assert.equal(siteContentSchema.safeParse(content).success, false)
  content.courses = [course('first')]
  assert.equal(siteContentSchema.safeParse(content).success, true)
})

test('links accept HTTP, root paths and anchors but reject executable and ambiguous URLs', () => {
  const content = getCurrent(createDatabase()).content
  for (const url of [
    'https://example.com',
    'http://example.com',
    '/courses',
    '#courses',
  ]) {
    content.site.contacts.links = [{ url, label: 'Link' }]
    assert.equal(siteContentSchema.safeParse(content).success, true, url)
  }
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,test',
    '//example.com',
    '/\\example.com',
    ' https://example.com',
    '#',
  ]) {
    content.site.contacts.links = [{ url, label: 'Link' }]
    assert.equal(siteContentSchema.safeParse(content).success, false, url)
  }
})

test('stale saves fail without altering content or history', () => {
  const db = createDatabase()
  const original = getCurrent(db)
  const content = {
    ...original.content,
    site: { ...original.content.site, title: 'Updated' },
  }
  const updated = saveContent(db, { content, baseRevision: original.revision })

  assert.throws(
    () =>
      saveContent(db, {
        content: original.content,
        baseRevision: original.revision,
      }),
    { code: 'REVISION_CONFLICT' },
  )
  assert.deepEqual(getCurrent(db), updated)
  assert.equal(listRevisions(db).length, 2)
})

test('restoring appends a revision and preserves previous content and pagination', () => {
  const db = createDatabase()
  const original = getCurrent(db)
  const updated = saveContent(db, {
    baseRevision: original.revision,
    content: {
      ...original.content,
      site: { ...original.content.site, title: 'Updated' },
    },
  })
  const restored = restoreRevision(db, original.revision, updated.revision)

  assert.ok(restored.revision > updated.revision)
  assert.deepEqual(restored.content, original.content)
  assert.deepEqual(getRevision(db, updated.revision), updated)
  assert.deepEqual(
    listRevisions(db, 2).map(item => item.revision),
    [restored.revision, updated.revision],
  )
  assert.deepEqual(
    listRevisions(db, 2, updated.revision).map(item => item.revision),
    [original.revision],
  )
  assert.throws(
    () => restoreRevision(db, original.revision, updated.revision),
    { code: 'REVISION_CONFLICT' },
  )
  assert.throws(() => getRevision(db, 999), { code: 'REVISION_NOT_FOUND' })
  assert.equal(listRevisions(db).length, 3)
})

test('every image reference must exist, including images in hidden content', () => {
  const db = createDatabase()
  const original = getCurrent(db)
  const imageId = 'a'.repeat(64)
  const content = {
    ...original.content,
    courses: [{ ...course('hidden', false), imageId }],
  }
  assert.throws(
    () => saveContent(db, { content, baseRevision: original.revision }),
    { code: 'MEDIA_NOT_FOUND' },
  )
  assert.equal(listRevisions(db).length, 1)

  db.prepare(
    "INSERT INTO media (id, kind, mime_type, size, created_at, data) VALUES (?, 'image', 'image/png', 1, ?, ?)",
  ).run(imageId, new Date().toISOString(), new Uint8Array([0]))
  const saved = saveContent(db, { content, baseRevision: original.revision })
  assert.deepEqual(collectMediaIds(saved.content), [imageId])
})

test('all block types collect their image references without duplicates', () => {
  const content = getCurrent(createDatabase()).content
  const imageId = 'a'.repeat(64)
  const otherImageId = 'b'.repeat(64)
  content.blocks = [
    {
      imageId,
      text: '',
      title: '',
      id: 'hero',
      type: 'hero',
      action: null,
      visible: true,
    },
    { imageId, text: '', title: '', id: 'about', type: 'about', visible: true },
    { text: '', title: '', id: 'text', type: 'text', visible: true },
    { title: '', id: 'courses', visible: true, courseIds: [], type: 'courses' },
    {
      title: '',
      id: 'gallery',
      visible: true,
      type: 'gallery',
      images: [{ alt: '', imageId: otherImageId }],
    },
    {
      title: '',
      visible: true,
      id: 'testimonials',
      type: 'testimonials',
      items: [{ imageId, text: '', author: 'Author' }],
    },
    {
      id: 'faq',
      title: '',
      type: 'faq',
      visible: true,
      items: [{ answer: '', question: 'Question' }],
    },
    { text: '', title: '', visible: true, id: 'contacts', type: 'contacts' },
  ]
  assert.equal(siteContentSchema.safeParse(content).success, true)
  assert.deepEqual(collectMediaIds(content), [imageId, otherImageId])
})

test('oversized documents and referenced images cannot create a revision', () => {
  const db = createDatabase()
  const initial = getCurrent(db)
  const content: SiteContent = {
    ...initial.content,
    blocks: Array.from({ length: 60 }, (_, index) => ({
      title: '',
      type: 'text',
      visible: true,
      id: `text-${index}`,
      text: 'я'.repeat(10_000),
    })),
  }
  assert.throws(
    () => saveContent(db, { content, baseRevision: initial.revision }),
    { code: 'CONTENT_TOO_LARGE' },
  )

  const imageId = 'a'.repeat(64)
  db.prepare(
    "INSERT INTO media (id, kind, mime_type, size, created_at, data) VALUES (?, 'image', 'image/png', ?, ?, ?)",
  ).run(
    imageId,
    MAX_CONTENT_MEDIA_BYTES + 1,
    new Date().toISOString(),
    Buffer.alloc(MAX_CONTENT_MEDIA_BYTES + 1),
  )
  content.blocks = []
  content.courses = [{ ...course('course'), imageId }]
  assert.throws(
    () => saveContent(db, { content, baseRevision: initial.revision }),
    { code: 'CONTENT_MEDIA_TOO_LARGE' },
  )
  assert.equal(listRevisions(db).length, 1)
})

test('restore verifies referenced images and fails atomically when an image is missing', () => {
  const db = createDatabase()
  const initial = getCurrent(db)
  const imageId = 'a'.repeat(64)
  db.prepare(
    "INSERT INTO media (id, kind, mime_type, size, created_at, data) VALUES (?, 'image', 'image/png', 1, ?, ?)",
  ).run(imageId, new Date().toISOString(), new Uint8Array([0]))
  const saved = saveContent(db, {
    baseRevision: initial.revision,
    content: {
      ...initial.content,
      courses: [{ ...course('course'), imageId }],
    },
  })
  const current = saveContent(db, {
    content: initial.content,
    baseRevision: saved.revision,
  })
  db.prepare('DELETE FROM media WHERE id = ?').run(imageId)

  assert.throws(() => restoreRevision(db, saved.revision, current.revision), {
    code: 'MEDIA_NOT_FOUND',
  })
  assert.deepEqual(getCurrent(db), current)
  assert.equal(listRevisions(db).length, 3)
})

test('public content excludes hidden blocks and courses and removes hidden course references', () => {
  const db = createDatabase()
  const initial = getCurrent(db)
  const content: SiteContent = {
    ...initial.content,
    courses: [course('visible'), course('hidden', false)],
    blocks: [
      {
        title: '',
        id: 'hidden',
        type: 'text',
        visible: false,
        text: 'Private',
      },
      {
        title: '',
        id: 'courses',
        visible: true,
        type: 'courses',
        courseIds: ['hidden', 'visible'],
      },
    ],
  }
  saveContent(db, { content, baseRevision: initial.revision })

  const published = getPublicContent(db).content
  assert.deepEqual(
    published.courses.map(item => item.id),
    ['visible'],
  )
  assert.deepEqual(published.blocks, [
    {
      title: '',
      id: 'courses',
      visible: true,
      type: 'courses',
      courseIds: ['visible'],
    },
  ])
  assert.equal(siteContentSchema.safeParse(published).success, true)
  assert.deepEqual(getCurrent(db).content, content)
})
