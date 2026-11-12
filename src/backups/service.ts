import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { z } from 'zod'

import { backupSchema } from './schema.js'
import { AppError } from '../errors/index.js'
import { transaction } from '../storage/index.js'
import type { SavedContent } from '../content/index.js'
import type { Backup, RestoreBackupInput } from './types.js'
import { getMedia, storeImage, validateImage } from '../media/index.js'
import {
  getCurrent,
  getRevision,
  saveContent,
  collectMediaIds,
  MAX_CONTENT_BYTES,
  MAX_CONTENT_MEDIA_BYTES,
} from '../content/index.js'

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024

export function createBackup(db: DatabaseSync, revision?: number): Backup {
  const saved =
    revision === undefined ? getCurrent(db) : getRevision(db, revision)

  const media = collectMediaIds(saved.content).map(id => {
    const { item, data } = getMedia(db, id)
    return { id, mimeType: item.mimeType, dataBase64: data.toString('base64') }
  })

  return backupSchema.parse({
    media,
    version: 1,
    content: saved.content,
    format: 'persona1ia-backup',
    exportedAt: new Date().toISOString(),
  })
}

export function restoreBackup(
  db: DatabaseSync,
  input: RestoreBackupInput,
): SavedContent {
  const baseRevision = z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(input.baseRevision)
  if (getCurrent(db).revision !== baseRevision) {
    throw new AppError(
      409,
      'REVISION_CONFLICT',
      'Content has changed; reload it before restoring',
    )
  }

  const backup = backupSchema.parse(input.backup)
  if (Buffer.byteLength(JSON.stringify(backup.content)) > MAX_CONTENT_BYTES) {
    throw new AppError(
      413,
      'CONTENT_TOO_LARGE',
      'Backup content must not exceed 1 MiB',
    )
  }

  const required = new Set(collectMediaIds(backup.content))
  const supplied = new Set<string>()
  let totalBytes = 0
  const images = backup.media.map(media => {
    if (supplied.has(media.id) || !required.has(media.id)) {
      throw new AppError(
        400,
        'INVALID_BACKUP',
        'Backup media must match the content references exactly',
      )
    }
    supplied.add(media.id)

    const data = Buffer.from(media.dataBase64, 'base64')
    if (data.toString('base64') !== media.dataBase64) {
      throw new AppError(
        400,
        'INVALID_BACKUP',
        'Backup contains invalid base64 data',
      )
    }
    if (createHash('sha256').update(data).digest('hex') !== media.id) {
      throw new AppError(
        400,
        'INVALID_BACKUP',
        'Backup image checksum does not match its ID',
      )
    }
    validateImage(data, media.mimeType)
    totalBytes += data.length
    if (totalBytes > MAX_CONTENT_MEDIA_BYTES) {
      throw new AppError(
        413,
        'CONTENT_MEDIA_TOO_LARGE',
        'Backup images must not exceed 32 MiB in total',
      )
    }

    return { data, mimeType: media.mimeType }
  })

  if (required.size !== supplied.size) {
    throw new AppError(
      400,
      'INVALID_BACKUP',
      'Backup is missing referenced images',
    )
  }

  return transaction(db, () => {
    if (getCurrent(db).revision !== baseRevision) {
      throw new AppError(
        409,
        'REVISION_CONFLICT',
        'Content has changed; reload it before restoring',
      )
    }
    for (const image of images) {
      storeImage(db, image.data, image.mimeType)
    }
    return saveContent(db, { baseRevision, content: backup.content })
  })
}
