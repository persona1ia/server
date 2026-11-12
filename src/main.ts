import { createHttpServer } from './http/index.js'

const port = Number(process.env.PORT ?? 3000)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535')
}

const server = createHttpServer()

server.listen(port, '0.0.0.0', () => {
  console.info(`Server listening on port ${port}`)
})

function shutdown() {
  server.close()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
