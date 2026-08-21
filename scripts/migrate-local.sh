#!/bin/bash
# Run migrations against the local Netlify dev database
# Usage: ./scripts/migrate-local.sh

# Read the connection string from .netlify/state.json
DB_URL=$(node -e "console.log(require('./.netlify/state.json').dbConnectionString)")

if [ -z "$DB_URL" ]; then
  echo "Error: Could not read database URL from .netlify/state.json"
  echo "Make sure 'netlify dev' is running first."
  exit 1
fi

echo "Running migrations against: $DB_URL"
DATABASE_URL="$DB_URL" node scripts/migrate.js
