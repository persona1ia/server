import { createHttpServer } from './http/index.js'

const port = 3000
const server = createHttpServer()

server.listen(port, '0.0.0.0', () => {
  console.info(`Server listening on port ${port}`)
})

function shutdown() {
  server.close()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
