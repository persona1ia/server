import type { DatabaseSync } from 'node:sqlite'

export interface ServerOptions {
  logger?: boolean
  databasePath?: string
  database?: DatabaseSync
  secureCookies?: boolean
}
