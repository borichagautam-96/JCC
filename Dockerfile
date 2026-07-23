# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build the frontend
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./

# --ignore-scripts skips native module compilation (e.g. better-sqlite3). The
# frontend build (Vite) is pure JS and never runs better-sqlite3, so there's no
# need to compile it here — this avoids needing a compiler in the builder stage.
RUN npm config set registry https://registry.npmjs.org/ \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-factor 10 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm ci --ignore-scripts

COPY . .
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Production runtime
#
# ✅ Zero apt-get installs  — avoids corporate proxy blocking .deb downloads
# ✅ No eclipse-temurin     — avoids HTTP-only Docker registry mirror issues
# ✅ No nginx               — Node.js already serves static files via
#                             express.static('../dist') in server/index.js
#
# Java / @opendataloader/pdf:
#   The server wraps extractPdfWithOpenDataLoader() in try/catch (jcc.js).
#   When Java is absent the error is caught and the request falls through
#   automatically to the pure-JavaScript pdfjs geometric parser — no Java
#   required in production Docker containers.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# ── Install system dependencies ─────────────────────────────────────────────
# • openjdk-17-jre-headless : @opendataloader/pdf JAR (Java 11 bytecode, needs Java 11+)
# • poppler-utils           : pdftoppm — converts ANY PDF page to a PNG image
#                             (the only reliable way to OCR scanned/image-based PDFs)
# • tesseract-ocr           : Tesseract OCR native binary for server-side OCR fallback
# • python3 / make / g++    : toolchain to COMPILE better-sqlite3 from source when no
#                             prebuilt binary is available for this platform.
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends \
        openjdk-17-jre-headless \
        poppler-utils \
        tesseract-ocr \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# Install production Node.js dependencies only
COPY package*.json ./
RUN npm config set registry https://registry.npmjs.org/ \
    && npm config set fetch-retries 5 \
    && npm config set fetch-retry-factor 10 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm ci --omit=dev

# Copy built React frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy public assets into dist
COPY --from=builder /app/public ./dist

# Copy source assets (images, logos) for runtime access
COPY --from=builder /app/src/assets ./src/assets

# Copy server code
COPY server ./server

# Create the persistent data directory + a seed directory.
RUN mkdir -p /app/data /app/seed

# Bundle a SEED database (users / vendors / POs only — no operational data, devices
# unbound). The startup CMD copies this into /app/data ONLY on the FIRST run (when
# the mounted volume has no database yet). On every later start/redeploy the existing
# live database is left untouched. This is how your users travel WITH the image/tar
# without ever clobbering real production data.
COPY database.clean.db /app/seed/database.db

# Fallback symlink only used if DB_PATH is unset (compose sets DB_PATH=/app/data/database.db).
RUN ln -s /app/data/database.db /app/database.db || true

# Copy uploads directory
COPY uploads ./uploads

# Copy environment file
COPY .env /app/.env

# ── CRITICAL: Patch .env for container runtime ────────────────────────────────
# The .env file has PORT=8032 (dev setting) and APP_BASE_URL pointing to localhost:8032.
# Inside the container the server MUST bind to port 8033 (the EXPOSE port).
# Without this patch, Node.js reads PORT=8032 from .env and binds there,
# but Docker maps host→8033→container:8033 where NOTHING is listening → ERR_EMPTY_RESPONSE.
RUN sed -i 's/^PORT=.*/PORT=8033/' /app/.env \
    && sed -i 's|^APP_BASE_URL=.*|APP_BASE_URL=http://localhost:8033|' /app/.env


# Create required runtime directories
RUN mkdir -p server/uploads server/temp

# Symlink server/uploads to the persistent /app/uploads volume
RUN rm -rf server/uploads && ln -s /app/uploads /app/server/uploads

# Persistent volumes
VOLUME ["/app/data", "/app/uploads"]

# Node.js serves EVERYTHING on this port:
#  - React static files  → express.static('../dist')  (server/index.js:54)
#  - All /api/* routes   → Express router
#  - SPA fallback        → app.get('*')               (server/index.js:91)
EXPOSE 8033

ENV NODE_ENV=production

# Health check using Node.js http module (no wget/curl needed)
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8033/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# ── CRITICAL PORT FIX ─────────────────────────────────────────────────────────
# Node.js --env-file overrides Docker ENV variables — .env PORT=8032 wins over
# ENV PORT=8033. Fix: patch .env at container STARTUP so node reads PORT=8033.
CMD ["sh", "-c", "if [ ! -s /app/data/database.db ]; then echo 'First run: seeding database (users/vendors/POs)...'; cp /app/seed/database.db /app/data/database.db; fi; sed -i 's/^PORT=.*/PORT=8033/' /app/.env && sed -i 's|^APP_BASE_URL=.*|APP_BASE_URL=http://localhost:8033|' /app/.env && node --env-file=/app/.env /app/server/index.js"]

