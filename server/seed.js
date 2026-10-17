import { pool, seedDatabase } from './index.js'

if (!pool) throw new Error('Set DATABASE_URL before running npm run seed')

try {
  await seedDatabase(pool, { reset: process.env.RESET_DEMO === '1' })
  console.log(process.env.RESET_DEMO === '1' ? 'Demo tenant data reset.' : 'Demo tenants seeded.')
} finally {
  await pool.end()
}