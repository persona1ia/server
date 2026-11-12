import type { DatabaseSync } from 'node:sqlite'

import type { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify'

import { AppError } from '../errors/index.js'
import { authenticate } from '../auth/index.js'

export const SESSION_COOKIE = 'persona1ia_session'

export function installRequestSecurity(
  app: FastifyInstance,
  secureCookies: boolean,
) {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Cache-Control', 'no-store')

    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new AppError(
        403,
        'CROSS_ORIGIN_REQUEST',
        'Запрос должен поступать с того же сайта.',
      )
    }
    const origin = request.headers.origin
    if (origin) {
      let originUrl: URL
      try {
        originUrl = new URL(origin)
      } catch {
        throw new AppError(
          403,
          'CROSS_ORIGIN_REQUEST',
          'Недопустимый источник запроса.',
        )
      }
      const protocol = secureCookies ? 'https:' : 'http:'
      if (
        originUrl.host !== request.headers.host ||
        originUrl.protocol !== protocol
      ) {
        throw new AppError(
          403,
          'CROSS_ORIGIN_REQUEST',
          'Запрос должен поступать с того же сайта.',
        )
      }
    }
  })
}

export function requireAdmin(db: DatabaseSync, request: FastifyRequest) {
  if (!authenticate(db, request.cookies[SESSION_COOKIE])) {
    throw new AppError(401, 'UNAUTHORIZED', 'Необходим вход администратора.')
  }
}

// A global bucket bounds password hashing even behind a reverse proxy.
export function rateLimit(capacity: number, refillMilliseconds: number) {
  let tokens = capacity
  let updatedAt = Date.now()
  return async (_request: FastifyRequest, reply: FastifyReply) => {
    const now = Date.now()
    tokens = Math.min(capacity, tokens + (now - updatedAt) / refillMilliseconds)
    updatedAt = now
    if (tokens < 1) {
      reply.header(
        'Retry-After',
        Math.ceil(((1 - tokens) * refillMilliseconds) / 1000),
      )
      throw new AppError(
        429,
        'RATE_LIMITED',
        'Слишком много запросов. Повторите позже.',
      )
    }
    tokens -= 1
  }
}
