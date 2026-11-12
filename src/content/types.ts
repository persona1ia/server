import type { z } from 'zod'

import type { siteContentSchema } from './schema.js'

export type SiteContent = z.infer<typeof siteContentSchema>

export interface RevisionSummary {
  savedAt: string
  revision: number
}

export interface SavedContent extends RevisionSummary {
  content: SiteContent
}

export interface SaveContentInput {
  content: unknown
  baseRevision: number
}

export interface RevisionRow {
  id: number
  document: string
  created_at: string
}
