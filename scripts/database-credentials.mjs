const missingPassword = 'Database password is required. Run ./setup.sh for a new installation, or set DATABASE_URL (or a Keychain selector) with your existing database password. Replace CHANGE_ME_DB_PASSWORD before starting.'

export function requireDatabasePassword(password) {
  if (typeof password !== 'string' || !password.trim() || password === 'CHANGE_ME_DB_PASSWORD') {
    throw new Error(missingPassword)
  }
}

/** Validate without echoing the URL, password, or a URL parser's exception. */
export function validateDatabaseUrl(value) {
  let url, password
  try {
    url = new URL(value)
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || /\s/.test(value)) throw new Error()
    // libpq/pg accepts query parameters overriding the credentials in the authority.
    password = url.searchParams.getAll('password').at(-1) ?? decodeURIComponent(url.password)
  } catch {
    throw new Error('Invalid DATABASE_URL. Provide a PostgreSQL URL with an explicit database password.')
  }
  requireDatabasePassword(password)
  return value
}
