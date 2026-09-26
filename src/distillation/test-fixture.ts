import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from '../db/schema.js'
import { RetryStore } from './retry-store.js'
import { createStreamRepository } from '../stream/repository.js'
import { createDistillationRepository } from './repository.js'
const exec = promisify(execFile)
export const bin = process.env.OPEN_BRAIN_TEST_PG_BIN
export async function startFixture() {
  if (!bin) throw new Error('OPEN_BRAIN_TEST_PG_BIN required; never use production DSN')
  const root = await mkdtemp('/tmp/ob-service-'), socket = join(root,'socket')
  await mkdir(socket,{mode:0o700})
  await exec(join(bin,'initdb'),['-D',join(root,'data'),'-A','trust','-U','fixture','--no-locale','--encoding=UTF8'])
  await writeFile(join(root,'data/postgresql.auto.conf'),`listen_addresses=''\nunix_socket_directories='${socket}'\n`)
  await exec(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'log'),'-w','start'])
  const admin = new pg.Client({host:socket,database:'postgres',user:'fixture'});await admin.connect()
  const pools:pg.Pool[]=[]
  return {
    async database() {
      const database='test_'+randomUUID().replaceAll('-','');await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
      const pool=new pg.Pool({host:socket,database,user:'fixture'});pools.push(pool)
      await pool.query('CREATE EXTENSION vector')
      const migration=await readFile(new URL('../db/migrate.ts',import.meta.url),'utf8')
      for(const match of migration.matchAll(/const [A-Z0-9_]+_SQL = `([\s\S]*?)`/g)) await pool.query(match[1]!)
      await pool.query(await readFile(new URL('../../ops/sql/distillation-retry.sql',import.meta.url),'utf8'))
      const db=drizzle(pool,{schema}), store=new RetryStore(pool,{baseDelayMs:0,maxDelayMs:0,maxAttempts:8})
      return {pool,store,stream:createStreamRepository(db,30),logs:createDistillationRepository(db)}
    },
    async close(){for(const pool of pools)await pool.end();await admin.end();await exec(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','fast','-w','stop']);console.log(`Service fixture retained (stopped): ${root}`)},
  }
}
