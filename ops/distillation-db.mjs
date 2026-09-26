// Explicit operator command. Never imported by application startup.
import { readFile } from 'node:fs/promises'
import { readConfig, sourceConnection, inventory } from '../scripts/backup/lib.mjs'
const action = process.argv[2]
if (!['inspect','migrate'].includes(action)) throw new Error('Usage: distillation-db.mjs inspect|migrate')
const config = await readConfig(), client = await sourceConnection(config)
try {
  await client.connect()
  await client.query("SET statement_timeout='30s'; SET lock_timeout='10s'")
  if (action === 'inspect') await client.query('BEGIN READ ONLY')
  const before = await inventory(client)
  const streamBefore = (await client.query(`SELECT id,md5(content) AS content_hash,distilled_at,expires_at FROM stream ORDER BY id`)).rows
  if (action === 'migrate') {
    await client.query(await readFile(new URL('./sql/distillation-retry.sql',import.meta.url),'utf8'))
    const after = await inventory(client)
    for (const t of before.tables) if (after.tables.find(a=>a.name===t.name && a.schema===t.schema)?.rows!==t.rows) throw new Error('Existing table count changed')
    const streamAfter = (await client.query('SELECT id,md5(content) AS content_hash,distilled_at,expires_at FROM stream ORDER BY id')).rows
    if (JSON.stringify(streamBefore)!==JSON.stringify(streamAfter)) throw new Error('Stream changed during migration')
    console.log(JSON.stringify({at:new Date().toISOString(),action,before:before.tables,after:after.tables,streamPreserved:true}))
  } else {
    const expired = (await client.query('SELECT id,md5(content) AS content_hash,distilled_at FROM stream WHERE expires_at<now() AND NOT pinned ORDER BY id')).rows
    const hasJobs=before.tables.some(t=>t.name==='distillation_retry_jobs')
    const jobs=hasJobs ? (await client.query('SELECT state,blocked,count(*)::int AS n FROM distillation_retry_jobs GROUP BY state,blocked')).rows : []
    console.log(JSON.stringify({at:new Date().toISOString(),tables:before.tables,streamHashes:streamBefore,expired,jobs}))
    await client.query('ROLLBACK')
  }
} catch { console.error('Database operation failed; private details suppressed');process.exitCode=1 }
finally { await client.end() }
