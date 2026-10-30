# syntax=docker/dockerfile:1

# Small static attach client: reads effective VM flags from JREs without a JDK.
FROM alpine:3.22 AS jattach
RUN apk add --no-cache build-base curl
WORKDIR /build
RUN curl -fsSL https://github.com/jattach/jattach/archive/refs/tags/v2.2.tar.gz -o source.tar.gz \
 && echo 'dc29ebb4fe795a026698fd77d04072cfb39295276a541cfc5e77d20b1509a1cf  source.tar.gz' | sha256sum -c - \
 && tar -xzf source.tar.gz \
 && make -C jattach-2.2 CFLAGS='-O2 -static' \
 && cp jattach-2.2/build/jattach /jattach

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

# Descriptor-relative filesystem operations use Python standard-library dir_fd APIs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*

# Runs as root so it can read the mounted Docker socket (root:docker on the host).
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=jattach /jattach ./dist/services/jattach
COPY --from=jattach /build/jattach-2.2/LICENSE /usr/share/licenses/jattach/LICENSE

EXPOSE 4000
CMD ["node", "dist/index.js"]
