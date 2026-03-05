import pg from 'pg'
import pgvector from 'pgvector/pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema.js'
import { logger } from '../shared/logger.js'
import { DatabaseError } from '../shared/errors.js'

export type Database = ReturnType<typeof drizzle<typeof schema>>

export async function createDatabase(connectionString: string): Promise<{ db: Database; pool: pg.Pool }> {
  try {
    const pool = new pg.Pool({ connectionString })

    const client = await pool.connect()
    await pgvector.registerTypes(client)
    client.release()

    const db = drizzle(pool, { schema })
    logger.info('Database connected successfully')

    return { db, pool }
  } catch (error) {
    throw new DatabaseError('Failed to connect to database', error)
  }
}
