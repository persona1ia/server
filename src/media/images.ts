import { AppError } from '../errors/index.js'

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

function detectImageMime(data: Buffer): string | undefined {
  if (
    data.length >= 58 &&
    data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    data.readUInt32BE(8) === 13 &&
    data.toString('latin1', 12, 16) === 'IHDR' &&
    data.readUInt32BE(16) > 0 &&
    data.readUInt32BE(20) > 0 &&
    data.includes(Buffer.from('IDAT'), 33) &&
    data.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))
  ) {
    return 'image/png'
  }

  if (
    data.length >= 32 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff &&
    data[3] !== 0 &&
    data[3] !== 0xff &&
    data.includes(Buffer.from('ffda', 'hex'), 4) &&
    data.subarray(-2).equals(Buffer.from('ffd9', 'hex'))
  ) {
    return 'image/jpeg'
  }

  if (
    data.length >= 26 &&
    ['GIF87a', 'GIF89a'].includes(data.toString('latin1', 0, 6)) &&
    data.readUInt16LE(6) > 0 &&
    data.readUInt16LE(8) > 0 &&
    data.subarray(13, -11).includes(0x2c) &&
    data[data.length - 1] === 0x3b
  ) {
    return 'image/gif'
  }

  if (
    data.length >= 20 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.readUInt32LE(4) + 8 === data.length &&
    data.toString('latin1', 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('latin1', 12, 16)) &&
    data.readUInt32LE(16) > 0 &&
    data.readUInt32LE(16) <= data.length - 20
  ) {
    return 'image/webp'
  }

  return undefined
}

export function validateImage(data: Buffer, declaredMime: string): void {
  if (data.length > MAX_IMAGE_BYTES) {
    throw new AppError(413, 'IMAGE_TOO_LARGE', 'Images must not exceed 10 MiB')
  }

  const detectedMime = detectImageMime(data)
  if (detectedMime === undefined || detectedMime !== declaredMime) {
    throw new AppError(
      415,
      'INVALID_IMAGE',
      'Expected a PNG, JPEG, GIF or WebP image matching its Content-Type',
    )
  }
}
