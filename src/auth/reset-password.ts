import { resetPassword } from './service.js'
import { openDatabase } from '../storage/index.js'

const db = openDatabase()

try {
  const password = await resetPassword(db)
  console.info(`Новый пароль администратора: ${password}`)
  console.info(
    'Все предыдущие сеансы завершены. Сохраните пароль в надёжном месте.',
  )
} catch {
  console.error('Не удалось сбросить пароль администратора.')
  process.exitCode = 1
} finally {
  db.close()
}
