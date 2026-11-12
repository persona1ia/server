import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { validateImage } from './images.js'
import { AppError } from '../errors/index.js'
import { transaction } from '../storage/index.js'
import type {
  MediaRow,
  MediaItem,
  StoredMedia,
  StoredMediaRow,
} from './types.js'

function toMediaItem(row: MediaRow): MediaItem {
  return {
    id: row.id,
    size: row.size,
    kind: row.kind,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    url: `/api/media/${row.id}`,
  }
}

export function getMedia(db: DatabaseSync, id: string): StoredMedia {
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id) as
    StoredMediaRow | undefined

  if (!row) {
    throw new AppError(404, 'MEDIA_NOT_FOUND', 'Media was not found')
  }

  return { item: toMediaItem(row), data: Buffer.from(row.data) }
}

export function storeImage(
  db: DatabaseSync,
  data: Buffer,
  declaredMime: string,
): MediaItem {
  validateImage(data, declaredMime)
  const id = createHash('sha256').update(data).digest('hex')

  return transaction(db, () => {
    db.prepare(
      `INSERT OR IGNORE INTO media (id, kind, mime_type, size, created_at, data)
       VALUES (?, 'image', ?, ?, ?, ?)`,
    ).run(id, declaredMime, data.length, new Date().toISOString(), data)
    return getMedia(db, id).item
  })
}

export function listMedia(
  db: DatabaseSync,
  limit = 50,
  offset = 0,
): MediaItem[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new AppError(400, 'INVALID_PAGINATION', 'Invalid media pagination')
  }

  const rows = db
    .prepare(
      `SELECT id, kind, mime_type, size, created_at FROM media
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as unknown as MediaRow[]

  return rows.map(toMediaItem)
}

export function deleteMedia(db: DatabaseSync, id: string): void {
  transaction(db, () => {
    const exists = db.prepare('SELECT id FROM media WHERE id = ?').get(id)
    if (!exists) {
      throw new AppError(404, 'MEDIA_NOT_FOUND', 'Media was not found')
    }

    const reference = db
      .prepare(
        `SELECT 1 FROM revisions, json_tree(revisions.document) AS node
         WHERE node.type = 'text' AND node.value = ? LIMIT 1`,
      )
      .get(id)

    if (reference) {
      throw new AppError(
        409,
        'MEDIA_IN_USE',
        'Media is referenced by a saved revision and cannot be deleted',
      )
    }

    db.prepare('DELETE FROM media WHERE id = ?').run(id)
  })
}
