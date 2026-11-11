FROM node:22.14.0-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Production-only dependencies for minimal worker runtime (no devDependencies/tsx)
FROM node:22.14.0-alpine AS prod-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Dedicated builder for background worker (compiles worker TypeScript without frontend Next.js/Turbopack build)
FROM node:22.14.0-alpine AS worker-builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build:worker

# Dedicated builder for web frontend (Next.js production build)
FROM node:22.14.0-alpine AS web-builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Backwards compatibility alias
FROM web-builder AS builder

# Base runner image with non-root nextjs user
FROM node:22.14.0-alpine AS runner-base
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && mkdir -p /app/data \
  && chown -R nextjs:nodejs /app/data

# Target 1: web (Next.js HTTP server)
FROM runner-base AS web
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=web-builder --chown=nextjs:nodejs /app/public ./public
COPY --from=web-builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=web-builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/api/health/ready || exit 1

CMD ["node", "server.js"]

# Target 2: worker (Background job runner without tsx or devDependencies)
FROM runner-base AS worker
COPY --from=prod-dependencies --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=worker-builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=worker-builder --chown=nextjs:nodejs /app/dist ./dist

USER nextjs
CMD ["node", "dist/worker.js"]
