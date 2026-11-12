import type { DatabaseSync } from 'node:sqlite'

import { z } from 'zod'

import { AppError } from '../errors/index.js'
import { transaction } from '../storage/index.js'
import { createDefaultContent } from './defaults.js'
import { MAX_CONTENT_BYTES, MAX_CONTENT_MEDIA_BYTES } from './limits.js'
import {
  revisionIdSchema,
  saveContentSchema,
  siteContentSchema,
} from './schema.js'
import type {
  RevisionRow,
  SiteContent,
  SavedContent,
  RevisionSummary,
} from './types.js'

export function initializeContent(db: DatabaseSync): void {
  transaction(db, () => {
    if (!db.prepare('SELECT id FROM revisions LIMIT 1').get()) {
      insertRevision(db, createDefaultContent())
    }
  })
}

export function getCurrent(db: DatabaseSync): SavedContent {
  const row = db
    .prepare(
      'SELECT id, created_at, document FROM revisions ORDER BY id DESC LIMIT 1',
    )
    .get() as RevisionRow | undefined

  if (!row) {
    throw new AppError(
      500,
      'CONTENT_NOT_INITIALIZED',
      'Content has not been initialized',
    )
  }

  return readRevision(row)
}

export function getRevision(db: DatabaseSync, id: number): SavedContent {
  const row = db
    .prepare('SELECT id, created_at, document FROM revisions WHERE id = ?')
    .get(revisionIdSchema.parse(id)) as RevisionRow | undefined

  if (!row) {
    throw new AppError(404, 'REVISION_NOT_FOUND', 'Revision does not exist')
  }

  return readRevision(row)
}

export function listRevisions(
  db: DatabaseSync,
  limit = 50,
  before?: number,
): RevisionSummary[] {
  z.number().int().min(1).max(100).parse(limit)
  const rows =
    before === undefined
      ? db
          .prepare(
            'SELECT id, created_at FROM revisions ORDER BY id DESC LIMIT ?',
          )
          .all(limit)
      : db
          .prepare(
            'SELECT id, created_at FROM revisions WHERE id < ? ORDER BY id DESC LIMIT ?',
          )
          .all(revisionIdSchema.parse(before), limit)

  return rows.map(row => ({
    revision: Number(row.id),
    savedAt: String(row.created_at),
  }))
}

export function saveContent(db: DatabaseSync, input: unknown): SavedContent {
  const { content, baseRevision } = saveContentSchema.parse(input)

  return transaction(db, () => {
    requireCurrentRevision(db, baseRevision)
    requireMedia(db, content)
    return insertRevision(db, content)
  })
}

export function restoreRevision(
  db: DatabaseSync,
  id: number,
  baseRevision: number,
): SavedContent {
  revisionIdSchema.parse(baseRevision)

  return transaction(db, () => {
    requireCurrentRevision(db, baseRevision)
    const { content } = getRevision(db, id)
    requireMedia(db, content)
    return insertRevision(db, content)
  })
}

export function getPublicContent(db: DatabaseSync): SavedContent {
  const saved = getCurrent(db)
  const courses = saved.content.courses.filter(course => course.visible)
  const courseIds = new Set(courses.map(course => course.id))

  return {
    ...saved,
    content: {
      ...saved.content,
      courses,
      blocks: saved.content.blocks
        .filter(block => block.visible)
        .map(block =>
          block.type === 'courses'
            ? {
                ...block,
                courseIds: block.courseIds.filter(id => courseIds.has(id)),
              }
            : block,
        ),
    },
  }
}

export function collectMediaIds(content: SiteContent): string[] {
  const ids = new Set<string>()
  for (const course of content.courses) {
    if (course.imageId !== null) {
      ids.add(course.imageId)
    }
  }

  for (const block of content.blocks) {
    switch (block.type) {
      case 'hero':
      case 'about':
        if (block.imageId !== null) {
          ids.add(block.imageId)
        }
        break
      case 'gallery':
        for (const image of block.images) {
          ids.add(image.imageId)
        }
        break
      case 'testimonials':
        for (const item of block.items) {
          if (item.imageId !== null) {
            ids.add(item.imageId)
          }
        }
        break
      case 'text':
      case 'courses':
      case 'faq':
      case 'contacts':
        break
      default: {
        const unknownBlock: never = block
        throw new Error(`Unsupported block: ${JSON.stringify(unknownBlock)}`)
      }
    }
  }

  return [...ids]
}

function readRevision(row: RevisionRow): SavedContent {
  return {
    revision: row.id,
    savedAt: row.created_at,
    content: siteContentSchema.parse(JSON.parse(row.document)),
  }
}

function insertRevision(db: DatabaseSync, content: SiteContent): SavedContent {
  const document = JSON.stringify(content)
  if (Buffer.byteLength(document) > MAX_CONTENT_BYTES) {
    throw new AppError(
      413,
      'CONTENT_TOO_LARGE',
      'Content must not exceed 1 MiB',
    )
  }

  const savedAt = new Date().toISOString()
  const result = db
    .prepare('INSERT INTO revisions (created_at, document) VALUES (?, ?)')
    .run(savedAt, document)

  return { savedAt, content, revision: Number(result.lastInsertRowid) }
}

function requireCurrentRevision(db: DatabaseSync, expected: number): void {
  const row = db
    .prepare('SELECT id FROM revisions ORDER BY id DESC LIMIT 1')
    .get()
  if (row?.id !== expected) {
    throw new AppError(
      409,
      'REVISION_CONFLICT',
      'Content has changed; reload it before saving',
    )
  }
}

function requireMedia(db: DatabaseSync, content: SiteContent): void {
  const findMedia = db.prepare(
    "SELECT size FROM media WHERE id = ? AND kind = 'image'",
  )
  let totalBytes = 0
  for (const id of collectMediaIds(content)) {
    const media = findMedia.get(id)
    if (!media) {
      throw new AppError(400, 'MEDIA_NOT_FOUND', `Image ${id} does not exist`)
    }
    totalBytes += Number(media.size)
  }

  if (totalBytes > MAX_CONTENT_MEDIA_BYTES) {
    throw new AppError(
      413,
      'CONTENT_MEDIA_TOO_LARGE',
      'Referenced images must not exceed 32 MiB in total',
    )
  }
}
