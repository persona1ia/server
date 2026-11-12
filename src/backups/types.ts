import type { z } from 'zod'

import type { backupSchema } from './schema.js'

export type Backup = z.infer<typeof backupSchema>

export interface RestoreBackupInput {
  backup: unknown
  baseRevision: number
}
