#!/bin/sh
set -e

# Start nginx in the background
nginx &

# Start Node.js server in the foreground
exec node /app/server/index.js
