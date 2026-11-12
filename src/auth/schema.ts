import { z } from 'zod'

export const changePasswordSchema = z.strictObject({
  newPassword: z.string().min(12).max(1024),
  currentPassword: z.string().min(1).max(1024),
})
