import pg from 'pg'

const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'
const testDbName = process.env.TEST_DATABASE_NAME ?? 'noxatrading_test'

const client = new pg.Client({ connectionString: adminUrl })

await client.connect()

try {
  await client.query(`CREATE DATABASE ${testDbName}`)
} catch (error) {
  if (error.code !== '42P04') {
    throw error
  }
} finally {
  await client.end()
}
