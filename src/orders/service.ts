import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { z } from 'zod'

import type { Order } from './types.js'
import { AppError } from '../errors/index.js'
import { getCurrent } from '../content/index.js'
import { transaction } from '../storage/index.js'

const checkoutSchema = z.strictObject({
  courseId: z.string().min(1).max(100),
})
const idempotencyKeySchema = z.uuid()

const orderColumns = `id, course_id AS courseId, course_title AS courseTitle,
  price_minor AS priceMinor, currency, status, created_at AS createdAt`

export function simulateCheckout(
  db: DatabaseSync,
  input: unknown,
  key: unknown,
): Order {
  const { courseId } = checkoutSchema.parse(input)
  const idempotencyKey = idempotencyKeySchema.parse(key)
  return transaction(db, () => {
    const existing = db
      .prepare(`SELECT ${orderColumns} FROM orders WHERE idempotency_key = ?`)
      .get(idempotencyKey) as Order | undefined
    if (existing) {
      if (existing.courseId !== courseId) {
        throw new AppError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Этот ключ уже использован для другого курса.',
        )
      }
      return existing
    }

    const course = getCurrent(db).content.courses.find(
      item => item.id === courseId && item.visible,
    )
    if (!course) {
      throw new AppError(404, 'COURSE_NOT_FOUND', 'Курс не найден или скрыт.')
    }
    const order: Order = {
      id: randomUUID(),
      courseId: course.id,
      status: 'simulated_paid',
      courseTitle: course.title,
      currency: course.currency,
      priceMinor: course.priceMinor,
      createdAt: new Date().toISOString(),
    }
    db.prepare(
      `INSERT INTO orders
      (id, idempotency_key, course_id, course_title, price_minor, currency, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      order.id,
      idempotencyKey,
      order.courseId,
      order.courseTitle,
      order.priceMinor,
      order.currency,
      order.status,
      order.createdAt,
    )
    return order
  })
}

export function listOrders(db: DatabaseSync, limit = 50, offset = 0): Order[] {
  return db
    .prepare(
      `SELECT ${orderColumns} FROM orders ORDER BY rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as unknown as Order[]
}
