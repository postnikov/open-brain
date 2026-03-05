import pino from 'pino'

export const logger = pino({
  transport: {
    target: 'pino/file',
    options: { destination: 2 },
  },
  level: process.env.LOG_LEVEL ?? 'info',
})

export type Logger = typeof logger
