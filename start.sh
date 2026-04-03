#!/bin/sh
set -e

# Start nginx in the background
nginx &

# Ensure backend gets runtime env values in production containers.
# Environment variables already provided by Docker still take precedence.
if [ -f /app/.env ]; then
	exec node --env-file=/app/.env /app/server/index.js
fi

# Fallback when no env file is present.
exec node /app/server/index.js
