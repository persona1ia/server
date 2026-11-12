import { createServer } from 'node:http'

export function createHttpServer() {
  return createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')

    if (request.method === 'GET' && request.url === '/') {
      response.end(JSON.stringify({ message: 'Persona1ia API is running' }))
      return
    }

    response.statusCode = 404
    response.end(JSON.stringify({ message: 'Not found' }))
  })
}
