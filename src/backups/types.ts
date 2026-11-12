import type { z } from 'zod'

import type { backupSchema } from './schema.js'

export type Backup = z.infer<typeof backupSchema>
