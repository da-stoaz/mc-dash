# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-only

# --- Build stage ---
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# The browser always uses /api; src/proxy.ts forwards it to the backend named by
# MC_DASH_BACKEND_URL at runtime, so one published image serves any backend port.
ARG NEXT_PUBLIC_API_BASE_URL=/api
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN npm run build

# --- Runtime stage ---
# Only Next's standalone output: server.js with the traced subset of
# node_modules, plus the static assets it serves. No dev dependencies, sources
# or build cache.
FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/da-stoaz/mc-dash"
WORKDIR /app
ENV NODE_ENV=production
# server.js listens on HOSTNAME, which Docker otherwise sets to the container ID.
# Compose sets the production bind address.
ENV HOSTNAME=0.0.0.0

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

EXPOSE 3000
# Compose supplies the production bind address (HOSTNAME), PORT and MC_DASH_BACKEND_URL.
CMD ["node", "server.js"]
