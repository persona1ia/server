export interface AuthSession {
  token: string
  expiresAt: number
}

export interface PasswordRow {
  hash: string
}

export interface SessionRow {
  expires_at: number
}
