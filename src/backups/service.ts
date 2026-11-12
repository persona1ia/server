import type { DatabaseSync } from 'node:sqlite'

import type { Backup } from './types.js'
import { AppError } from '../errors/index.js'
import { transaction } from '../storage/index.js'
import type { SavedContent } from '../content/index.js'
import { getMedia, storeImage } from '../media/index.js'
import { backupSchema, restoreBackupSchema } from './schema.js'
import {
  getCurrent,
  getRevision,
  saveContent,
  collectMediaIds,
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

export function restoreBackup(db: DatabaseSync, input: unknown): SavedContent {
  const { backup, baseRevision } = restoreBackupSchema.parse(input)

  return transaction(db, () => {
    const remaining = new Set(collectMediaIds(backup.content))
    for (const media of backup.media) {
      if (!remaining.delete(media.id)) {
        throw new AppError(
          400,
          'INVALID_BACKUP',
          'Backup media must match the content references exactly',
        )
      }

      const data = Buffer.from(media.dataBase64, 'base64')
      if (data.toString('base64') !== media.dataBase64) {
        throw new AppError(
          400,
          'INVALID_BACKUP',
          'Backup contains invalid base64 data',
        )
      }

      const image = storeImage(db, data, media.mimeType)
      if (image.id !== media.id) {
        throw new AppError(
          400,
          'INVALID_BACKUP',
          'Backup image checksum does not match its ID',
        )
      }
    }

    if (remaining.size > 0) {
      throw new AppError(
        400,
        'INVALID_BACKUP',
        'Backup is missing referenced images',
      )
    }

    return saveContent(db, { baseRevision, content: backup.content })
  })
}
