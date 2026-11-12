import type { SiteContent } from './types.js'

export function createDefaultContent(): SiteContent {
  return {
    blocks: [],
    courses: [],
    schemaVersion: 1,
    site: {
      title: '',
      description: '',
      contacts: { email: '', phone: '', links: [], address: '' },
    },
  }
}
