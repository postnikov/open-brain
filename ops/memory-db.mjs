// Explicit operator command for the memory-tiers rollout. Never imported by application startup.
// Prints counts and hashes only; vault paths and thought text stay in the private evidence file.
//
//   node ops/memory-db.mjs inspect
//   node ops/memory-db.mjs migrate <target>             (memory-tiers.sql in one transaction + checks)
//   node ops/memory-db.mjs rollback <target>            (memory-tiers-rollback.sql)
//   node ops/memory-db.mjs repair-paths --vault <root> --evidence <file> [--apply] <target>
//   node ops/memory-db.mjs restore-paths --evidence <file> <target>
// <target> is mandatory for mutations: --production, or --rehearsal-socket <dir> for a
// restored scratch cluster. Unknown arguments are fatal. The chosen target goes to stderr.
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile, rename, access } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import pg from 'pg'
import { readConfig, sourceConnection, inventory } from '../scripts/backup/lib.mjs'

const [action, ...rest] = process.argv.slice(2)
const actions = ['inspect', 'migrate', 'rollback', 'repair-paths', 'restore-paths']
if (!actions.includes(action)) throw new Error(`Usage: memory-db.mjs ${actions.join('|')}`)
// Strict parsing (2026-10-08 incident): zsh does not word-split an unquoted "$S", so
// "--rehearsal-socket <dir>" arrived as ONE argument, was silently ignored and the
// "rehearsal" ran against production. Unknown arguments are now fatal, and every
// mutating action must name its target explicitly: --production or --rehearsal-socket.
const VALUE_FLAGS = ['--vault', '--evidence', '--rehearsal-socket', '--rehearsal-db', '--rehearsal-user']
const BOOL_FLAGS = ['--apply', '--production']
const opts = {}
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]
  if (VALUE_FLAGS.includes(a)) {
    const v = rest[++i]
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
    opts[a] = v
  } else if (BOOL_FLAGS.includes(a)) opts[a] = true
  else throw new Error(`Unknown argument (quote shell variables separately): ${JSON.stringify(a.slice(0, 40))}`)
}
const flag = (name) => opts[name]
if (opts['--production'] && opts['--rehearsal-socket']) throw new Error('Choose one target: --production or --rehearsal-socket')
if (action !== 'inspect' && !opts['--production'] && !opts['--rehearsal-socket']) throw new Error('Mutating action needs an explicit target: --production or --rehearsal-socket <dir>')

const nfc = (s) => s.normalize('NFC')
const hash16 = (text) => createHash('sha256').update(text.trim()).digest('hex').slice(0, 16)
const exists = (p) => access(p).then(() => true, () => false)
const sqlFile = (name) => readFile(new URL(`./sql/${name}`, import.meta.url), 'utf8')

async function atomicPrivate(path, value) {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(tmp, path)
}

/** Every user-visible thought field the migration must not touch (source_ref/tier excluded). */
async function fingerprint(client) {
  const rows = (await client.query(`SELECT id, md5(content) AS c, md5(coalesce(title,'')) AS t, tags, created_at, composted_at, weight
    FROM thoughts ORDER BY id`)).rows
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

async function stats(client) {
  return (await client.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE source_ref IS NULL OR source_ref = '')::int AS no_ref,
    count(*) FILTER (WHERE source_ref LIKE 'unattributed:%')::int AS unattributed,
    count(*) FILTER (WHERE source_ref LIKE '{"distillation_run_id"%' AND source_ref LIKE '%"legacy" : true}')::int AS legacy_run
    FROM thoughts`)).rows[0]
}

async function vaultIndex(root) {
  const byName = new Map(), byHash = new Map()
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const name = nfc(entry.name)
        byName.set(name, [...(byName.get(name) ?? []), full])
        const h = hash16(await readFile(full, 'utf8'))
        byHash.set(h, [...(byHash.get(h) ?? []), full])
      }
    }
  }
  await walk(root)
  return { byName, byHash }
}

// Rehearsal target: a restored scratch cluster reachable only through its Unix socket
// (`--rehearsal-socket <dir>`); production is never addressed this way.
const rehearsal = flag('--rehearsal-socket')
console.error(`memory-db ${action} → ${rehearsal ? 'REHEARSAL ' + rehearsal : 'PRODUCTION'}`)
const client = rehearsal
  ? new pg.Client({ host: rehearsal, port: 5432, database: flag('--rehearsal-db') ?? 'open_brain_restorecheck', user: flag('--rehearsal-user') ?? 'restore_admin' })
  : await sourceConnection(await readConfig())
try {
  await client.connect()
  await client.query("SET statement_timeout='60s'; SET lock_timeout='10s'")
  if (action === 'inspect') {
    await client.query('BEGIN READ ONLY')
    const cols = (await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='thoughts' AND column_name IN ('tier','superseded_by','valid_to','open_count')")).rows[0].n
    console.log(JSON.stringify({ at: new Date().toISOString(), memoryColumns: cols, ...(await stats(client)), fingerprint: await fingerprint(client) }))
    await client.query('ROLLBACK')
  } else if (action === 'migrate' || action === 'rollback') {
    const before = await inventory(client), fpBefore = await fingerprint(client), statsBefore = await stats(client)
    await client.query(`BEGIN;\n${await sqlFile(action === 'migrate' ? 'memory-tiers.sql' : 'memory-tiers-rollback.sql')}\nCOMMIT;`)
    const after = await inventory(client)
    for (const t of before.tables) if (after.tables.find((a) => a.name === t.name && a.schema === t.schema)?.rows !== t.rows) throw new Error('Existing table count changed')
    if (await fingerprint(client) !== fpBefore) throw new Error('Thought content/metadata changed during migration')
    const statsAfter = await stats(client)
    if (action === 'migrate' && statsAfter.no_ref !== 0) throw new Error('NULL source_ref remains after migration')
    console.log(JSON.stringify({ at: new Date().toISOString(), action, tables: after.tables, before: statsBefore, after: statsAfter, contentPreserved: true }))
  } else if (action === 'repair-paths') {
    const root = flag('--vault'), evidence = flag('--evidence'), apply = !!flag('--apply')
    if (!root || !evidence) throw new Error('repair-paths needs --vault <root> --evidence <file>')
    if (await exists(evidence)) throw new Error('Evidence file exists; inspect the previous attempt')
    const index = await vaultIndex(root)
    const rows = (await client.query("SELECT id, source_ref, obsidian_path, content FROM thoughts WHERE source = 'obsidian' ORDER BY id")).rows
    const changes = [], counts = { total: rows.length, alive: 0, byContent: 0, byName: 0, byNameAndContent: 0, ambiguous: 0, notFound: 0 }
    for (const r of rows) {
      if (r.source_ref && await exists(r.source_ref)) { counts.alive++; continue }
      const h = hash16(r.content)
      const sameContent = index.byHash.get(h) ?? []
      const sameName = index.byName.get(nfc(basename(r.source_ref ?? ''))) ?? []
      let target = null, method = null
      if (sameName.length === 1) { target = sameName[0]; method = 'byName' }
      else if (sameName.length > 1) {
        const both = sameName.filter((p) => sameContent.includes(p))
        if (both.length === 1) { target = both[0]; method = 'byNameAndContent' }
      } else if (sameContent.length === 1) { target = sameContent[0]; method = 'byContent' }
      if (!target) { counts[sameName.length > 1 ? 'ambiguous' : 'notFound']++; continue }
      counts[method]++
      changes.push({ id: r.id, method, old_source_ref: r.source_ref, old_obsidian_path: r.obsidian_path, new_source_ref: target, new_obsidian_path: relative(root, target), unchanged_content: sameContent.includes(target) })
    }
    const summary = { at: new Date().toISOString(), apply, counts, changes: changes.length, unchangedContent: changes.filter((c) => c.unchanged_content).length }
    if (apply) {
      await atomicPrivate(evidence, { ...summary, vault: root, changes })
      await client.query('BEGIN')
      for (const c of changes) {
        const res = await client.query('UPDATE thoughts SET source_ref = $2, obsidian_path = $3 WHERE id = $1 AND source_ref IS NOT DISTINCT FROM $4', [c.id, c.new_source_ref, c.new_obsidian_path, c.old_source_ref])
        if (res.rowCount !== 1) { await client.query('ROLLBACK'); throw new Error('Concurrent change; nothing applied') }
      }
      await client.query('COMMIT')
    }
    console.log(JSON.stringify(summary))
  } else if (action === 'restore-paths') {
    const evidence = flag('--evidence')
    if (!evidence) throw new Error('restore-paths needs --evidence <file>')
    const { changes } = JSON.parse(await readFile(evidence, 'utf8'))
    await client.query('BEGIN')
    let restored = 0
    for (const c of changes) {
      const res = await client.query('UPDATE thoughts SET source_ref = $2, obsidian_path = $3 WHERE id = $1 AND source_ref = $4', [c.id, c.old_source_ref, c.old_obsidian_path, c.new_source_ref])
      restored += res.rowCount
    }
    await client.query('COMMIT')
    console.log(JSON.stringify({ at: new Date().toISOString(), action, restored, expected: changes.length }))
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  // PostgreSQL errors can carry connection details; print only our own messages.
  console.error(error instanceof Error && !error.code ? error.message : 'Database operation failed; private details suppressed')
  process.exitCode = 1
} finally { await client.end() }
