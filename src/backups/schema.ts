import { z } from 'zod'

import { MAX_IMAGE_BYTES } from '../media/index.js'
import { siteContentSchema } from '../content/index.js'

export const backupSchema = z.strictObject({
  version: z.literal(1),
  content: siteContentSchema,
  exportedAt: z.iso.datetime(),
  format: z.literal('persona1ia-backup'),
  media: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      dataBase64: z
        .string()
        .min(1)
        .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
    }),
  ),
})
