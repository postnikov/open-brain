import { defineConfig } from 'drizzle-kit'
import 'dotenv/config'
import { getDatabaseUrl } from './src/config/loader.js'
import { DEFAULT_CONFIG } from './src/config/defaults.js'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: getDatabaseUrl(DEFAULT_CONFIG),
  },
})
