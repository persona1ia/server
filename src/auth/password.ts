import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'

const keyLength = 64

function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { r: 8, p: 1, N: 32768, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) {
          reject(error)
          return
        }

        resolve(key)
      },
    )
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const key = await deriveKey(password, salt)
  return `scrypt-v1:${salt}:${key.toString('hex')}`
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const match = /^scrypt-v1:([a-f0-9]{32}):([a-f0-9]{128})$/.exec(hash)
  const salt = match?.[1]
  const expected = match?.[2]

  if (!salt || !expected) {
    return false
  }

  const actual = await deriveKey(password, salt)
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'))
}
