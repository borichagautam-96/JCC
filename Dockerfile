# Stage 1: Build the frontend
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source code
COPY . .

# Build the frontend
RUN npm run build

# Stage 2: Production environment
FROM node:20-alpine

# Install nginx only
RUN apk add --no-cache nginx

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built frontend from builder stage
COPY --from=builder /app/dist ./dist

# Copy source assets (images, logos, etc.) for runtime access
COPY --from=builder /app/src/assets ./src/assets

# Copy server code
COPY server ./server

# Create persistent data directory
RUN mkdir -p /app/data

# Copy database file (with current data and credentials) to data directory
COPY database.db /app/data/database.db

# Create symlink for database to be accessible at original location
RUN ln -s /app/data/database.db /app/database.db

# Copy uploads directory (with all existing uploaded files)
COPY uploads ./uploads

# Copy nginx configuration
COPY nginx.conf /etc/nginx/nginx.conf

COPY .env /app/.env

# Copy startup script
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Create necessary directories
RUN mkdir -p server/uploads server/temp /var/log/nginx /var/run

# Create symlink for server uploads to point to main uploads directory
RUN rm -rf server/uploads && ln -s /app/uploads /app/server/uploads

# Define volumes for persistence
VOLUME ["/app/data", "/app/uploads"]

# Expose ports
EXPOSE 8033

# Set environment variables
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8033/ || exit 1

# Start both nginx and node using startup script
CMD ["/app/start.sh"]
