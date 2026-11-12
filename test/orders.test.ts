import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { ZodError } from 'zod'

import { openDatabase } from '../src/storage/index.js'
import { listOrders, simulateCheckout } from '../src/orders/index.js'
import {
  getCurrent,
  saveContent,
  initializeContent,
} from '../src/content/index.js'

test('checkout accepts an idempotency key only separately from the strict request body', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  initializeContent(db)
  const initial = getCurrent(db)
  const courseId = 'course'
  saveContent(db, {
    baseRevision: initial.revision,
    content: {
      ...initial.content,
      courses: [
        {
          id: courseId,
          visible: true,
          imageId: null,
          title: 'Course',
          description: '',
          currency: 'RUB',
          priceMinor: 100,
        },
      ],
    },
  })
  const key = randomUUID()

  assert.throws(
    () => simulateCheckout(db, { courseId, idempotencyKey: key }, key),
    ZodError,
  )
  assert.throws(() => simulateCheckout(db, { courseId }, undefined), ZodError)
  assert.throws(() => simulateCheckout(db, null, key), ZodError)
  assert.throws(
    () => simulateCheckout(db, { courseId }, 'invalid-key'),
    ZodError,
  )
  assert.deepEqual(listOrders(db), [])

  const order = simulateCheckout(db, { courseId }, key)
  assert.deepEqual({ ...simulateCheckout(db, { courseId }, key) }, order)
  assert.equal(listOrders(db).length, 1)
})
