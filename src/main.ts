import { createHttpServer } from './http/index.js'

const port = 3000
const server = createHttpServer({ logger: true })

process.once('SIGINT', () => void server.close())
process.once('SIGTERM', () => void server.close())

try {
  await server.listen({ port, host: '0.0.0.0' })
} catch (error) {
  server.log.error(error)
  await server.close()
  process.exitCode = 1
}
