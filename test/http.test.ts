import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { TestContext } from 'node:test'

import { resetPassword } from '../src/auth/index.js'
import type { MediaItem } from '../src/media/index.js'
import { openDatabase } from '../src/storage/index.js'
import { createHttpServer } from '../src/http/index.js'
import type { SiteContent, SavedContent } from '../src/content/index.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=',
  'base64',
)

async function fixture(t: TestContext, secureCookies = false) {
  const db = openDatabase(':memory:')
  const app = createHttpServer({ database: db, secureCookies })
  t.after(async () => {
    await app.close()
    db.close()
  })
  const password = await resetPassword(db)
  return { db, app, password }
}

async function signIn(
  app: ReturnType<typeof createHttpServer>,
  password: string,
) {
  const response = await app.inject({
    method: 'POST',
    payload: { password },
    url: '/api/auth/login',
  })
  assert.equal(response.statusCode, 200, response.body)
  const cookie = response.cookies.find(
    item => item.name === 'persona1ia_session',
  )
  assert.ok(cookie)
  return `${cookie.name}=${cookie.value}`
}

function exampleContent(): SiteContent {
  return {
    schemaVersion: 1,
    site: {
      title: 'Expert',
      description: 'Courses',
      contacts: { email: '', phone: '', links: [], address: '' },
    },
    blocks: [
      {
        id: 'intro',
        type: 'hero',
        action: null,
        imageId: null,
        visible: true,
        title: 'Welcome',
        text: 'Expert introduction',
      },
      {
        id: 'catalog',
        visible: true,
        type: 'courses',
        title: 'Catalog',
        courseIds: ['alpha', 'hidden', 'beta'],
      },
      {
        type: 'text',
        visible: false,
        text: 'Hidden text',
        id: 'private-block',
        title: 'Not published',
      },
    ],
    courses: [
      {
        id: 'alpha',
        imageId: null,
        visible: true,
        currency: 'RUB',
        priceMinor: 99000,
        title: 'Alpha course',
        description: 'First course',
      },
      {
        id: 'beta',
        imageId: null,
        visible: true,
        currency: 'RUB',
        priceMinor: 199000,
        title: 'Beta course',
        description: 'Second course',
      },
      {
        id: 'hidden',
        imageId: null,
        visible: false,
        priceMinor: 100,
        currency: 'RUB',
        title: 'Hidden course',
        description: 'Not published',
      },
    ],
  }
}

test('administrative requests require a session before parsing their bodies', async t => {
  const { app } = await fixture(t)

  for (const url of [
    '/api/admin/content',
    '/api/admin/orders',
    '/api/admin/media',
  ]) {
    assert.equal((await app.inject({ url })).statusCode, 401)
  }
  const upload = await app.inject({
    method: 'POST',
    url: '/api/admin/media',
    payload: Buffer.from('not an image'),
    headers: { 'content-type': 'application/octet-stream' },
  })
  assert.equal(upload.statusCode, 401)
  const malformedContent = await app.inject({
    payload: '{',
    method: 'PUT',
    url: '/api/admin/content',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(malformedContent.statusCode, 401)
  assert.deepEqual((await app.inject('/health')).json(), { status: 'ok' })
})

test('login sets protected cookies and logout or reset revokes access', async t => {
  const { db, app, password } = await fixture(t, true)
  const login = await app.inject({
    method: 'POST',
    payload: { password },
    url: '/api/auth/login',
  })
  assert.equal(login.statusCode, 200, login.body)
  const setCookie = login.headers['set-cookie']
  assert.equal(typeof setCookie, 'string')
  assert.match(String(setCookie), /; HttpOnly/)
  assert.match(String(setCookie), /; SameSite=Strict/i)
  assert.match(String(setCookie), /; Secure/)
  const cookie = String(setCookie).split(';')[0]
  assert.ok(cookie)
  const headers = { cookie }

  const session = await app.inject({ headers, url: '/api/auth/session' })
  assert.equal(session.json().authenticated, true)
  const authorized = await app.inject({ headers, url: '/api/admin/content' })
  assert.equal(authorized.statusCode, 200)
  const logout = await app.inject({
    headers,
    method: 'POST',
    url: '/api/auth/logout',
  })
  assert.equal(logout.statusCode, 204)
  const loggedOut = await app.inject({ headers, url: '/api/admin/content' })
  assert.equal(loggedOut.statusCode, 401)

  const nextCookie = await signIn(app, password)
  await resetPassword(db)
  const revoked = await app.inject({
    url: '/api/admin/content',
    headers: { cookie: nextCookie },
  })
  assert.equal(revoked.statusCode, 401)
  const resetSession = await app.inject({
    url: '/api/auth/session',
    headers: { cookie: nextCookie },
  })
  assert.equal(resetSession.json().authenticated, false)
})

test('mutations accept the same origin and reject foreign origins or cross-site requests', async t => {
  const { app, password } = await fixture(t)
  const cookie = await signIn(app, password)
  const baseHeaders = { cookie, host: 'site.example:8080' }

  for (const headers of [
    { ...baseHeaders, origin: 'http://other.example:8080' },
    { ...baseHeaders, origin: 'https://site.example:8080' },
    { ...baseHeaders, origin: 'null' },
    { ...baseHeaders, 'sec-fetch-site': 'cross-site' },
  ]) {
    const response = await app.inject({
      headers,
      method: 'POST',
      url: '/api/auth/logout',
    })
    assert.equal(response.statusCode, 403, response.body)
  }

  const sameOrigin = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { ...baseHeaders, origin: 'http://site.example:8080' },
  })
  assert.equal(sameOrigin.statusCode, 204)
})

test('login attempts share a bounded rate limit independent of forwarded IPs', async t => {
  const { app, password } = await fixture(t)
  for (let index = 0; index < 5; index++) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong-password' },
      headers: { 'x-forwarded-for': `192.0.2.${index + 1}` },
    })
    assert.equal(response.statusCode, 401)
  }
  const limited = await app.inject({
    method: 'POST',
    payload: { password },
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': '192.0.2.100' },
  })
  assert.equal(limited.statusCode, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
})

test('content publishes immediately, filters hidden data and restores through a new revision', async t => {
  const { app, password } = await fixture(t)
  const headers = { cookie: await signIn(app, password) }
  const initial = (
    await app.inject({ headers, url: '/api/admin/content' })
  ).json<SavedContent>()
  const content = exampleContent()
  const save = await app.inject({
    headers,
    method: 'PUT',
    url: '/api/admin/content',
    payload: { content, baseRevision: initial.revision },
  })
  assert.equal(save.statusCode, 200, save.body)
  const first = save.json<SavedContent>()
  const publicSite = (await app.inject('/api/site')).json<SavedContent>()
  assert.deepEqual(
    publicSite.content.courses.map(course => course.id),
    ['alpha', 'beta'],
  )
  assert.deepEqual(
    publicSite.content.blocks.map(block => block.id),
    ['intro', 'catalog'],
  )
  const publicCatalog = publicSite.content.blocks.find(
    block => block.type === 'courses',
  )
  assert.ok(publicCatalog?.type === 'courses')
  assert.deepEqual(publicCatalog.courseIds, ['alpha', 'beta'])
  assert.equal(publicSite.revision, first.revision)

  const stale = await app.inject({
    headers,
    method: 'PUT',
    url: '/api/admin/content',
    payload: { content, baseRevision: initial.revision },
  })
  assert.equal(stale.statusCode, 409)
  content.site.title = 'Changed title'
  const secondSave = await app.inject({
    headers,
    method: 'PUT',
    url: '/api/admin/content',
    payload: { content, baseRevision: first.revision },
  })
  const second = secondSave.json<SavedContent>()
  const restored = await app.inject({
    headers,
    method: 'POST',
    payload: { baseRevision: second.revision },
    url: `/api/admin/revisions/${first.revision}/restore`,
  })
  assert.equal(restored.statusCode, 200, restored.body)
  const current = restored.json<SavedContent>()
  assert.ok(current.revision > second.revision)
  assert.deepEqual(current.content, first.content)
  const history = await app.inject({
    headers,
    url: `/api/admin/revisions?limit=1&before=${current.revision}`,
  })
  assert.equal(history.json().revisions[0].revision, second.revision)
  const historical = await app.inject({
    headers,
    url: `/api/admin/revisions/${first.revision}`,
  })
  assert.deepEqual(historical.json(), first)

  const schema = await app.inject({ headers, url: '/api/admin/content/schema' })
  assert.equal(schema.statusCode, 200, schema.body)
  assert.equal(schema.json().type, 'object')
  assert.ok(schema.json().properties.blocks)
})

test('binary image upload supports public caching and history protects referenced media', async t => {
  const { app, password } = await fixture(t)
  const headers = { cookie: await signIn(app, password) }
  const mismatched = await app.inject({
    payload: png,
    method: 'POST',
    url: '/api/admin/media',
    headers: { ...headers, 'content-type': 'image/jpeg' },
  })
  assert.equal(mismatched.statusCode, 415)
  const unsupported = await app.inject({
    method: 'POST',
    payload: '<svg/>',
    url: '/api/admin/media',
    headers: { ...headers, 'content-type': 'image/svg+xml' },
  })
  assert.equal(unsupported.statusCode, 415)
  const upload = await app.inject({
    payload: png,
    method: 'POST',
    url: '/api/admin/media',
    headers: { ...headers, 'content-type': 'image/png' },
  })
  assert.equal(upload.statusCode, 201, upload.body)
  const media = upload.json<MediaItem>()
  const download = await app.inject(media.url)
  assert.equal(download.statusCode, 200)
  assert.deepEqual(download.rawPayload, png)
  assert.equal(download.headers['content-type'], 'image/png')
  assert.match(String(download.headers['cache-control']), /immutable/)
  assert.equal(download.headers['x-content-type-options'], 'nosniff')
  const cached = await app.inject({
    url: media.url,
    headers: { 'if-none-match': `"${media.id}"` },
  })
  assert.equal(cached.statusCode, 304)
  assert.equal(cached.body, '')

  const content = exampleContent()
  const course = content.courses[0]
  assert.ok(course)
  course.imageId = media.id
  const initial = (
    await app.inject({ headers, url: '/api/admin/content' })
  ).json<SavedContent>()
  const saved = await app.inject({
    headers,
    method: 'PUT',
    url: '/api/admin/content',
    payload: { content, baseRevision: initial.revision },
  })
  assert.equal(saved.statusCode, 200, saved.body)
  course.imageId = null
  const removedReference = await app.inject({
    headers,
    method: 'PUT',
    url: '/api/admin/content',
    payload: { content, baseRevision: saved.json().revision },
  })
  assert.equal(removedReference.statusCode, 200)
  const deletion = await app.inject({
    headers,
    method: 'DELETE',
    url: `/api/admin/media/${media.id}`,
  })
  assert.equal(deletion.statusCode, 409)
  const listing = await app.inject({ headers, url: '/api/admin/media' })
  assert.equal(listing.json().media.length, 1)
})

test('downloaded backups restore content and image bytes into a fresh server', async t => {
  const source = await fixture(t)
  const sourceHeaders = { cookie: await signIn(source.app, source.password) }
  const upload = await source.app.inject({
    payload: png,
    method: 'POST',
    url: '/api/admin/media',
    headers: { ...sourceHeaders, 'content-type': 'image/png' },
  })
  const media = upload.json<MediaItem>()
  const content = exampleContent()
  const course = content.courses[0]
  assert.ok(course)
  course.imageId = media.id
  const initial = (
    await source.app.inject({
      headers: sourceHeaders,
      url: '/api/admin/content',
    })
  ).json<SavedContent>()
  const saved = await source.app.inject({
    method: 'PUT',
    headers: sourceHeaders,
    url: '/api/admin/content',
    payload: { content, baseRevision: initial.revision },
  })
  assert.equal(saved.statusCode, 200, saved.body)
  const download = await source.app.inject({
    headers: sourceHeaders,
    url: '/api/admin/backups/current',
  })
  assert.equal(download.statusCode, 200, download.body)
  assert.match(
    String(download.headers['content-disposition']),
    /attachment; filename="persona1ia-revision-\d+\.json"/,
  )
  const backup = download.json()
  assert.equal(backup.media.length, 1)
  assert.equal(backup.media[0].dataBase64, png.toString('base64'))
  const historical = await source.app.inject({
    headers: sourceHeaders,
    url: `/api/admin/backups/${saved.json().revision}`,
  })
  assert.equal(historical.statusCode, 200)
  assert.deepEqual(historical.json().content, content)

  const target = await fixture(t)
  const targetHeaders = { cookie: await signIn(target.app, target.password) }
  const targetInitial = (
    await target.app.inject({
      headers: targetHeaders,
      url: '/api/admin/content',
    })
  ).json<SavedContent>()
  const restored = await target.app.inject({
    method: 'POST',
    headers: targetHeaders,
    url: '/api/admin/backups/restore',
    payload: { backup, baseRevision: targetInitial.revision },
  })
  assert.equal(restored.statusCode, 200, restored.body)
  assert.deepEqual(restored.json().content, content)
  assert.ok(restored.json().revision > targetInitial.revision)
  assert.deepEqual((await target.app.inject(media.url)).rawPayload, png)
  const stale = await target.app.inject({
    method: 'POST',
    headers: targetHeaders,
    url: '/api/admin/backups/restore',
    payload: { backup, baseRevision: targetInitial.revision },
  })
  assert.equal(stale.statusCode, 409)
})

test('checkout is an idempotent simulation using server prices and rejecting payment data', async t => {
  const { app, password } = await fixture(t)
  const adminHeaders = { cookie: await signIn(app, password) }
  const content = exampleContent()
  const initial = (
    await app.inject({ headers: adminHeaders, url: '/api/admin/content' })
  ).json<SavedContent>()
  const saved = await app.inject({
    method: 'PUT',
    headers: adminHeaders,
    url: '/api/admin/content',
    payload: { content, baseRevision: initial.revision },
  })
  assert.equal(saved.statusCode, 200, saved.body)
  for (const headers of [{}, { 'idempotency-key': 'not-a-uuid' }]) {
    const invalid = await app.inject({
      headers,
      method: 'POST',
      url: '/api/checkout',
      payload: { courseId: 'alpha' },
    })
    assert.equal(invalid.statusCode, 400)
  }
  for (const field of [{ cardNumber: '4242424242424242' }, { priceMinor: 1 }]) {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      payload: { courseId: 'alpha', ...field },
      headers: { 'idempotency-key': randomUUID() },
    })
    assert.equal(invalid.statusCode, 400)
  }

  const key = randomUUID()
  const first = await app.inject({
    method: 'POST',
    url: '/api/checkout',
    payload: { courseId: 'alpha' },
    headers: { 'idempotency-key': key },
  })
  assert.equal(first.statusCode, 201, first.body)
  assert.equal(first.json().simulation, true)
  assert.equal(first.json().order.status, 'simulated_paid')
  assert.equal(first.json().order.priceMinor, 99000)

  const course = content.courses[0]
  assert.ok(course)
  course.priceMinor = 123400
  const updated = await app.inject({
    method: 'PUT',
    headers: adminHeaders,
    url: '/api/admin/content',
    payload: { content, baseRevision: saved.json().revision },
  })
  assert.equal(updated.statusCode, 200)
  const repeated = await app.inject({
    method: 'POST',
    url: '/api/checkout',
    payload: { courseId: 'alpha' },
    headers: { 'idempotency-key': key },
  })
  assert.equal(repeated.statusCode, 201)
  assert.deepEqual(repeated.json(), first.json())
  const fresh = await app.inject({
    method: 'POST',
    url: '/api/checkout',
    payload: { courseId: 'alpha' },
    headers: { 'idempotency-key': randomUUID() },
  })
  assert.equal(fresh.statusCode, 201)
  assert.equal(fresh.json().order.priceMinor, 123400)
  const conflict = await app.inject({
    method: 'POST',
    url: '/api/checkout',
    payload: { courseId: 'beta' },
    headers: { 'idempotency-key': key },
  })
  assert.equal(conflict.statusCode, 409)
  for (const courseId of ['hidden', 'missing']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/checkout',
      payload: { courseId },
      headers: { 'idempotency-key': randomUUID() },
    })
    assert.equal(response.statusCode, 404)
  }
  assert.equal((await app.inject('/api/admin/orders')).statusCode, 401)
  const orders = await app.inject({
    headers: adminHeaders,
    url: '/api/admin/orders',
  })
  assert.equal(orders.statusCode, 200)
  assert.equal(orders.json().orders.length, 2)
})

test('changing the password rotates the cookie and invalidates all old browser sessions', async t => {
  for (const secureCookies of [false, true]) {
    const { app, password } = await fixture(t, secureCookies)
    const firstCookie = await signIn(app, password)
    const secondCookie = await signIn(app, password)
    const newPassword = 'new-password'
    const changed = await app.inject({
      method: 'PUT',
      url: '/api/admin/password',
      payload: { newPassword, currentPassword: password },
      headers: {
        cookie: firstCookie,
        host: 'site.example',
        origin: `${secureCookies ? 'https' : 'http'}://site.example`,
      },
    })

    assert.equal(changed.statusCode, 200, changed.body)
    assert.equal(changed.json().authenticated, true)
    assert.ok(Date.parse(changed.json().expiresAt) > Date.now())
    const setCookie = changed.headers['set-cookie']
    assert.equal(typeof setCookie, 'string')
    assert.match(String(setCookie), /; HttpOnly/)
    assert.match(String(setCookie), /; SameSite=Strict/i)
    assert.equal(/; Secure/.test(String(setCookie)), secureCookies)
    const newCookie = String(setCookie).split(';')[0]
    assert.ok(newCookie)
    assert.notEqual(newCookie, firstCookie)
    assert.notEqual(newCookie, secondCookie)

    for (const cookie of [firstCookie, secondCookie]) {
      const revoked = await app.inject({
        headers: { cookie },
        url: '/api/admin/content',
      })
      assert.equal(revoked.statusCode, 401)
    }
    const retained = await app.inject({
      url: '/api/admin/content',
      headers: { cookie: newCookie },
    })
    assert.equal(retained.statusCode, 200)
    const oldLogin = await app.inject({
      method: 'POST',
      payload: { password },
      url: '/api/auth/login',
    })
    assert.equal(oldLogin.statusCode, 401)
    await signIn(app, newPassword)
  }
})

test('password changes require a session, matching origin and the current password', async t => {
  const { app, password } = await fixture(t)
  const payload = {
    currentPassword: password,
    newPassword: 'chosen-new-password',
  }
  const anonymous = await app.inject({
    payload,
    method: 'PUT',
    url: '/api/admin/password',
  })
  assert.equal(anonymous.statusCode, 401)

  const cookie = await signIn(app, password)
  const crossOrigin = await app.inject({
    payload,
    method: 'PUT',
    url: '/api/admin/password',
    headers: {
      cookie,
      host: 'site.example',
      origin: 'http://other.example',
    },
  })
  assert.equal(crossOrigin.statusCode, 403)

  const wrongPassword = await app.inject({
    method: 'PUT',
    headers: { cookie },
    url: '/api/admin/password',
    payload: { ...payload, currentPassword: 'wrong-password' },
  })
  assert.equal(wrongPassword.statusCode, 401)
  assert.equal(wrongPassword.headers['set-cookie'], undefined)
  const retained = await app.inject({
    headers: { cookie },
    url: '/api/admin/content',
  })
  assert.equal(retained.statusCode, 200)
  await signIn(app, password)
})

test('password change validation rejects invalid lengths and extra fields without changing access', async t => {
  const { app, password } = await fixture(t)
  const headers = { cookie: await signIn(app, password) }
  for (const payload of [
    { currentPassword: password, newPassword: 'a'.repeat(11) },
    { currentPassword: password, newPassword: 'a'.repeat(1025) },
    { currentPassword: '', newPassword: 'chosen-new-password' },
    { currentPassword: 'a'.repeat(1025), newPassword: 'chosen-new-password' },
    {
      unexpected: true,
      currentPassword: password,
      newPassword: 'chosen-new-password',
    },
  ]) {
    const response = await app.inject({
      headers,
      payload,
      method: 'PUT',
      url: '/api/admin/password',
    })
    assert.equal(response.statusCode, 400, response.body)
    assert.equal(response.headers['set-cookie'], undefined)
  }
  const retained = await app.inject({ headers, url: '/api/admin/content' })
  assert.equal(retained.statusCode, 200)
  await signIn(app, password)
})

test('password changes have their own rate limit and failures preserve the current session', async t => {
  const { app, password } = await fixture(t)
  const headers = { cookie: await signIn(app, password) }
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await app.inject({
      headers,
      method: 'PUT',
      url: '/api/admin/password',
      payload: {
        currentPassword: 'wrong-password',
        newPassword: 'chosen-new-password',
      },
    })
    assert.equal(response.statusCode, 401, response.body)
  }
  const limited = await app.inject({
    headers,
    method: 'PUT',
    url: '/api/admin/password',
    payload: {
      currentPassword: password,
      newPassword: 'chosen-new-password',
    },
  })
  assert.equal(limited.statusCode, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
  const retained = await app.inject({ headers, url: '/api/admin/content' })
  assert.equal(retained.statusCode, 200)
  await signIn(app, password)
})
