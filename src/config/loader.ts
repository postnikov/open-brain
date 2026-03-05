import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../shared/logger.js'
import { configSchema, type AppConfig } from './schema.js'
import { DEFAULT_CONFIG } from './defaults.js'

const CONFIG_DIR = join(homedir(), '.open-brain')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export async function loadConfig(): Promise<AppConfig> {
  if (!existsSync(CONFIG_FILE)) {
    logger.info({ path: CONFIG_FILE }, 'Config file not found, creating default')
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2))
    return DEFAULT_CONFIG
  }

  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8')
    const parsed = JSON.parse(raw)
    return configSchema.parse(parsed)
  } catch (error) {
    logger.warn({ error }, 'Failed to parse config, using defaults')
    return configSchema.parse({})
  }
}

export function getDatabaseUrl(config: AppConfig): string {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL
  }

  const { host, port, database, user, password } = config.database
  return `postgresql://${user}:${password}@${host}:${port}/${database}`
}
