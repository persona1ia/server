import { z } from 'zod'

const passwordSchema = z.string().min(1).max(1024)

export const loginSchema = z.strictObject({ password: passwordSchema })

export const changePasswordSchema = z.strictObject({
  currentPassword: passwordSchema,
  newPassword: z.string().min(12).max(1024),
})
