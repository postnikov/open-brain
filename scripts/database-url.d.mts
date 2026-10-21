export function readDatabaseSecret(service: string): string
export function resolveDatabaseUrl(
  env?: NodeJS.ProcessEnv,
  readSecret?: (service: string) => string,
): string | undefined
