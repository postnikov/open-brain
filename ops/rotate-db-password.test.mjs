import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { command, backup, verifyLatest, libpqEnv } from '../scripts/backup/lib.mjs'
import { scramVerifier, rotatePassword, rollbackPassword, loggingPreflight, probe } from './rotate-db-password.mjs'

const bin = process.env.OPEN_BRAIN_TEST_PG_BIN
describe.skipIf(!bin)('password rotation on an isolated PostgreSQL cluster', () => {
  let root, socket, admin, url, started = false
  const original = 'synthetic-original-password'
  const service = 'vibe/fixture/DATABASE_URL'
  const rollbackService = 'vibe/fixture/ROLLBACK'
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'rot-')); socket = join(root, 's'); await mkdir(socket, { mode: 0o700 })
    await command(join(bin, 'initdb'), ['-D',join(root,'data'),'-A','trust','-U','fixture_admin','--no-locale','--encoding=UTF8'])
    await writeFile(join(root,'data/postgresql.auto.conf'), `listen_addresses=''\nunix_socket_directories='${socket}'\n`)
    await command(join(bin,'pg_ctl'),['-D',join(root,'data'),'-l',join(root,'postgres.log'),'-w','start']); started=true
    admin = new pg.Client({ host:socket, user:'fixture_admin', database:'postgres' }); await admin.connect()
    await admin.query(`CREATE ROLE fixture LOGIN PASSWORD '${scramVerifier(original)}'`)
    await admin.query('CREATE DATABASE fixturedb OWNER fixture')
    await writeFile(join(root,'data/pg_hba.conf'),'local all fixture scram-sha-256\nlocal all all trust\n')
    await command(join(bin,'pg_ctl'),['-D',join(root,'data'),'reload'])
    url = `postgresql://fixture:${original}@localhost/fixturedb?host=${encodeURIComponent(socket)}`
    const c=new pg.Client({connectionString:url});await c.connect()
    await c.query('CREATE TABLE sentinel(n int); INSERT INTO sentinel VALUES (7)');await c.end()
  }, 30000)
  afterAll(async () => {
    await admin?.end()
    if (started) await command(join(bin,'pg_ctl'),['-D',join(root,'data'),'-m','fast','-w','stop'])
    if (root) console.log(`Stopped rotation fixture retained: ${root}`)
  })
  function store(initial=url) {
    const secrets=new Map([[service,initial]])
    return { secrets, reader:key=>{if(!secrets.has(key))throw new Error('missing');return secrets.get(key)}, writer:async(key,value)=>{secrets.set(key,value)} }
  }
  it('rotates as a non-superuser, revokes old credentials, preserves data, and rolls back twice', async () => {
    const {secrets,reader,writer}=store(), stateFile=join(root,'rotation.json')
    const state=await rotatePassword({service,rollbackService,stateFile,reader,writer})
    expect(state.oldPasswordRejected).toBe(true)
    const next=secrets.get(service); expect(next).not.toBe(url)
    expect(secrets.get(rollbackService)).toBe(url)
    const stored=await readFile(stateFile,'utf8')
    expect(stored).not.toContain(original)
    expect(stored).not.toContain(new URL(next).password)
    expect((await stat(stateFile)).mode&0o777).toBe(0o600)
    const c=new pg.Client({connectionString:next});await c.connect()
    expect((await c.query('SELECT n FROM sentinel')).rows).toEqual([{n:7}])
    const credentials=await libpqEnv(c)
    expect(credentials.passfile).toBeUndefined();expect(credentials.env.PGPASSFILE).toBeUndefined()
    expect(credentials.env.PGPASSWORD).toBe(new URL(next).password)
    await c.end()
    const cfg={directory:join(root,'backup'),restoreDirectory:join(root,'restore'),pgBin:bin,serverPlist:join(root,'server.json'),envFile:join(root,'.env'),appConfig:join(root,'app.json'),minFreeBytes:0}
    await writeFile(cfg.serverPlist,JSON.stringify({EnvironmentVariables:{DATABASE_URL:next}}));await writeFile(cfg.envFile,'')
    const dump=await backup(cfg);expect((await verifyLatest(cfg)).sha256).toBe(dump.sha256)
    await expect(probe(url)).rejects.toMatchObject({code:'28P01'})
    expect((await rollbackPassword(stateFile,{reader,writer})).status).toBe('rolled_back')
    expect(secrets.get(service)).toBe(url);await probe(url)
    await expect(probe(next)).rejects.toMatchObject({code:'28P01'})
    expect((await rollbackPassword(stateFile,{reader,writer})).status).toBe('rolled_back')
  })
  it('recovers a writer that fails after updating the active item', async () => {
    const s=store(), stateFile=join(root,'failure.json');let once=true
    const writer=async(key,value)=>{await s.writer(key,value);if(key===service&&once){once=false;throw new Error('synthetic failure after write')}}
    await expect(rotatePassword({service,rollbackService,stateFile,reader:s.reader,writer})).rejects.toThrow('rolled_back_after_failure')
    expect(s.secrets.get(service)).toBe(url);await probe(url)
    expect(JSON.parse(await readFile(stateFile,'utf8')).status).toBe('rolled_back_after_failure')
  })
  it('records trust authentication honestly without changing HBA policy', async () => {
    const s=store(`postgresql://fixture_admin:synthetic@localhost/postgres?host=${encodeURIComponent(socket)}`)
    const stateFile=join(root,'trust.json')
    const state=await rotatePassword({service,rollbackService,stateFile,reader:s.reader,writer:s.writer})
    expect(state.passwordAuthEnforced).toBe(false);expect(state.oldPasswordRejected).toBe(false)
    expect(state.status).toBe('password_rotated')
    await rollbackPassword(stateFile,{reader:s.reader,writer:s.writer})
  })
  it('refuses statement logging before a verifier can be sent', async () => {
    await admin.query("SET log_statement='all'")
    try { await expect(loggingPreflight(admin)).rejects.toThrow('logging is not safe') }
    finally { await admin.query("SET log_statement='none'") }
  })
})
