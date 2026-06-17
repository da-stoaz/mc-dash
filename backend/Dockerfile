# syntax=docker/dockerfile:1

# --- Build stage: compile TypeScript and build native deps (better-sqlite3) ---
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 may need to compile from source if no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runs as root so it can read the mounted Docker socket (root:docker on the host).
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 4000
CMD ["node", "dist/index.js"]
