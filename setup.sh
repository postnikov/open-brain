#!/bin/bash
set -e

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

if ! command -v psql &>/dev/null; then
  fail "PostgreSQL client (psql) not found. Install PostgreSQL 14+"
fi
info "PostgreSQL client OK"

if ! command -v npm &>/dev/null; then
  fail "npm not found"
fi

# --- .env file ---

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    info "Created .env from .env.example"
  else
    fail ".env.example not found"
  fi
fi

# Check for OpenAI API key
if grep -q "sk-your-key-here" .env 2>/dev/null; then
  echo ""
  warn "OpenAI API key not set in .env"
  echo -n "  Enter your OpenAI API key (or press Enter to skip): "
  read -r API_KEY
  if [ -n "$API_KEY" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|sk-your-key-here|$API_KEY|" .env
    else
      sed -i "s|sk-your-key-here|$API_KEY|" .env
    fi
    info "API key saved to .env"
  else
    warn "Skipped. Set OPENAI_API_KEY in .env before running."
  fi
fi

# --- npm install ---

info "Installing dependencies..."
npm install --silent
info "Dependencies installed"

# --- Database setup ---

echo ""
info "Setting up PostgreSQL database..."

DB_USER="open_brain"
DB_NAME="open_brain"
DB_PASS="open_brain_local"

# Try to create user (may already exist)
if psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" 2>/dev/null | grep -q 1; then
  info "Database user '$DB_USER' already exists"
else
  info "Creating database user '$DB_USER'..."
  if ! psql -U postgres -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" 2>/dev/null; then
    warn "Could not create user automatically."
    echo "  Run manually as postgres superuser:"
    echo "    CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';"
    echo ""
  else
    info "User created"
  fi
fi

# Try to create database (may already exist)
if psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1; then
  info "Database '$DB_NAME' already exists"
else
  info "Creating database '$DB_NAME'..."
  if ! psql -U postgres -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" 2>/dev/null; then
    warn "Could not create database automatically."
    echo "  Run manually as postgres superuser:"
    echo "    CREATE DATABASE $DB_NAME OWNER $DB_USER;"
    echo ""
  else
    info "Database created"
  fi
fi

# Enable pgvector extension
info "Enabling pgvector extension..."
if ! psql -U postgres -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null; then
  warn "Could not enable pgvector. You may need to install it first:"
  echo "  macOS:  brew install pgvector"
  echo "  Ubuntu: sudo apt install postgresql-16-pgvector"
  echo "  Then:   psql -U postgres -d $DB_NAME -c 'CREATE EXTENSION vector;'"
  echo ""
else
  info "pgvector extension enabled"
fi

# --- Run migrations ---

info "Running database migrations..."
if npm run migrate 2>/dev/null; then
  info "Migrations complete"
else
  warn "Migration failed. Check DATABASE_URL in .env and database access."
fi

# --- Done ---

echo ""
echo "  =============================="
echo -e "  ${GREEN}Setup complete!${NC}"
echo "  =============================="
echo ""
echo "  Start the web server:"
echo "    npm run server"
echo ""
echo "  Then open:"
echo "    http://localhost:3100"
echo ""
echo "  Other commands:"
echo "    npm run cli -- search \"your query\"   # CLI search"
echo "    npm run dev                           # MCP stdio server"
echo "    npm run test:api                      # API smoke tests"
echo ""
