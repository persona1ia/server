import Fastify from 'fastify'
import { z, ZodError } from 'zod'
import cookie from '@fastify/cookie'

import { AppError } from '../errors/index.js'
import type { ServerOptions } from './types.js'
import { openDatabase } from '../storage/index.js'
import { listOrders, simulateCheckout } from '../orders/index.js'
import {
  createBackup,
  restoreBackup,
  MAX_BACKUP_BYTES,
} from '../backups/index.js'
import {
  login,
  logout,
  authenticate,
  isPasswordConfigured,
} from '../auth/index.js'
import {
  rateLimit,
  requireAdmin,
  SESSION_COOKIE,
  installRequestSecurity,
} from './security.js'
import {
  getMedia,
  listMedia,
  storeImage,
  deleteMedia,
  MAX_IMAGE_BYTES,
} from '../media/index.js'
import {
  getCurrent,
  getRevision,
  saveContent,
  listRevisions,
  restoreRevision,
  getPublicContent,
  initializeContent,
  siteContentSchema,
} from '../content/index.js'

const revisionSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
const revisionParams = z.strictObject({ id: revisionSchema })
const mediaParams = z.strictObject({ id: z.string().regex(/^[a-f0-9]{64}$/) })
const baseRevisionSchema = z.strictObject({
  baseRevision: z.number().int().positive(),
})
const paginationSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
})

export function createHttpServer(options: ServerOptions = {}) {
  const db = options.database ?? openDatabase(options.databasePath)
  initializeContent(db)
  const secureCookies =
    options.secureCookies ?? process.env.NODE_ENV === 'production'
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: options.logger ?? false,
  })
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookies,
  } as const

  app.register(cookie)
  installRequestSecurity(app, secureCookies)
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Проверьте переданные данные.',
        issues: error.issues.map(({ path, message }) => ({ path, message })),
      })
    }
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ error: error.code, message: error.message })
    }
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply
        .status(error.statusCode)
        .send({ error: 'BAD_REQUEST', message: error.message })
    }
    request.log.error(error)
    return reply
      .status(500)
      .send({ error: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера.' })
  })
  app.setNotFoundHandler((_request, reply) =>
    reply
      .status(404)
      .send({ error: 'NOT_FOUND', message: 'Маршрут не найден.' }),
  )
  app.addHook('onClose', async () => {
    if (!options.database) {
      db.close()
    }
  })

  app.get('/health', async () => {
    db.prepare('SELECT 1').get()
    return { status: 'ok' }
  })
  app.get('/', async () => ({ message: 'Persona1ia API is running' }))
  app.get('/api/site', async () => getPublicContent(db))
  app.get('/api/media/:id', async (request, reply) => {
    const { id } = mediaParams.parse(request.params)
    const { item, data } = getMedia(db, id)
    reply.header('Cache-Control', 'public, max-age=31536000, immutable')
    reply.header('ETag', `"${id}"`)
    if (request.headers['if-none-match'] === `"${id}"`) {
      return reply.status(304).send()
    }
    return reply.type(item.mimeType).send(data)
  })
  app.post(
    '/api/auth/login',
    { onRequest: rateLimit(5, 12_000) },
    async (request, reply) => {
      const { password } = z
        .strictObject({ password: z.string().min(1).max(1024) })
        .parse(request.body)
      const session = await login(db, password)
      reply.setCookie(SESSION_COOKIE, session.token, {
        ...cookieOptions,
        expires: new Date(session.expiresAt),
      })
      return {
        authenticated: true,
        expiresAt: new Date(session.expiresAt).toISOString(),
      }
    },
  )
  app.get('/api/auth/session', async request => ({
    passwordConfigured: isPasswordConfigured(db),
    authenticated: authenticate(db, request.cookies[SESSION_COOKIE]),
  }))
  app.post('/api/auth/logout', async (request, reply) => {
    logout(db, request.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, cookieOptions)
    return reply.status(204).send()
  })
  app.post(
    '/api/checkout',
    { onRequest: rateLimit(30, 2000) },
    async (request, reply) => {
      const body = z
        .strictObject({ courseId: z.string().min(1).max(100) })
        .parse(request.body)
      const order = simulateCheckout(db, {
        ...body,
        idempotencyKey: request.headers['idempotency-key'],
      })
      return reply.status(201).send({ order, simulation: true })
    },
  )

  app.register(
    async admin => {
      admin.addHook('onRequest', async request => requireAdmin(db, request))
      admin.get('/content', async () => getCurrent(db))
      admin.get('/content/schema', async () =>
        z.toJSONSchema(siteContentSchema),
      )
      admin.put('/content', async request => {
        const input = z
          .strictObject({
            content: z.unknown(),
            baseRevision: z.number().int().positive(),
          })
          .parse(request.body)
        return saveContent(db, {
          content: input.content,
          baseRevision: input.baseRevision,
        })
      })
      admin.get('/revisions', async request => {
        const { limit, before } = z
          .strictObject({
            before: revisionSchema.optional(),
            limit: z.coerce.number().int().min(1).max(100).default(50),
          })
          .parse(request.query)
        return { revisions: listRevisions(db, limit, before) }
      })
      admin.get('/revisions/:id', async request =>
        getRevision(db, revisionParams.parse(request.params).id),
      )
      admin.post('/revisions/:id/restore', async request => {
        const { id } = revisionParams.parse(request.params)
        const { baseRevision } = baseRevisionSchema.parse(request.body)
        return restoreRevision(db, id, baseRevision)
      })
      admin.get('/backups/current', async (_request, reply) => {
        const revision = getCurrent(db).revision
        reply.header(
          'Content-Disposition',
          `attachment; filename="persona1ia-revision-${revision}.json"`,
        )
        return createBackup(db, revision)
      })
      admin.get('/backups/:id', async (request, reply) => {
        const { id } = revisionParams.parse(request.params)
        reply.header(
          'Content-Disposition',
          `attachment; filename="persona1ia-revision-${id}.json"`,
        )
        return createBackup(db, id)
      })
      admin.post(
        '/backups/restore',
        { bodyLimit: MAX_BACKUP_BYTES },
        async request => {
          const input = z
            .strictObject({
              backup: z.unknown(),
              baseRevision: z.number().int().positive(),
            })
            .parse(request.body)
          return restoreBackup(db, {
            backup: input.backup,
            baseRevision: input.baseRevision,
          })
        },
      )
      admin.get('/media', async request => {
        const { limit, offset } = paginationSchema.parse(request.query)
        return { media: listMedia(db, limit, offset) }
      })
      admin.addContentTypeParser(
        ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
        (_request, body, done) => done(null, body),
      )
      admin.post(
        '/media',
        { bodyLimit: MAX_IMAGE_BYTES },
        async (request, reply) => {
          if (!Buffer.isBuffer(request.body)) {
            throw new AppError(
              415,
              'UNSUPPORTED_MEDIA_TYPE',
              'Отправьте изображение бинарным телом запроса.',
            )
          }
          const mime =
            request.headers['content-type']?.split(';')[0]?.trim() ?? ''
          return reply.status(201).send(storeImage(db, request.body, mime))
        },
      )
      admin.delete('/media/:id', async (request, reply) => {
        deleteMedia(db, mediaParams.parse(request.params).id)
        return reply.status(204).send()
      })
      admin.get('/orders', async request => {
        const { limit, offset } = paginationSchema.parse(request.query)
        return { orders: listOrders(db, limit, offset) }
      })
    },
    { prefix: '/api/admin' },
  )

  return app
}
