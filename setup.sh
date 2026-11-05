#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
case "${1:-}" in
  ""|--env-only) ;;
  *) echo "Usage: ./setup.sh [--env-only]" >&2; exit 1 ;;
esac

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
fail() { echo -e "${RED}[x]${NC} $1"; exit 1; }

echo ""
echo "  Open Brain — Setup"
echo "  ==================="
echo ""

# --- Check dependencies ---

info "Checking dependencies..."

if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install Node.js 20+ from https://nodejs.org"
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  fail "Node.js $NODE_VER found, but 20+ required"
fi
info "Node.js $(node -v) OK"

# Generate credentials without installing dependencies or touching PostgreSQL.
node scripts/setup.mjs env
if [ "${1:-}" = "--env-only" ]; then
  info "Database credentials are in .env. Add OPENAI_API_KEY before starting the app."
  exit 0
fi

if ! command -v psql &>/dev/null; then
  fail "PostgreSQL client (psql) not found. Install PostgreSQL 14+"
fi
if ! command -v npm &>/dev/null; then
  fail "npm not found"
fi
warn "Set OPENAI_API_KEY in .env before starting the app."

# --- npm install ---

info "Installing dependencies..."
npm install --silent
info "Dependencies installed"

# --- Database setup ---

info "Setting up PostgreSQL using the credentials in .env..."
node --env-file=.env scripts/setup.mjs database

info "Running database migrations..."
if npm run migrate; then
  info "Migrations complete"
else
  fail "Migration failed. Check DATABASE_URL and database access; setup is incomplete."
fi

# --- Done ---

echo ""
echo "  =============================="
echo -e "  ${GREEN}Setup complete!${NC}"
echo "  =============================="
echo ""
echo "  Create an access token (see README, Quick Start step 2), then start"
echo "  the authenticated server:"
echo "    npm run server"
echo ""
echo "  Then open and paste the token:"
echo "    http://127.0.0.1:3100"
echo ""
echo "  Other commands:"
echo "    npm run cli -- search \"your query\"   # CLI search"
echo "    npm run dev                           # MCP stdio server"
echo "    npm run test:api                      # API smoke tests"
echo ""
