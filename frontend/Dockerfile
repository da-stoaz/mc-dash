# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# The browser always uses /api; Next proxies it to the backend. The proxy target
# compiled here is only a default: start.mjs repoints it from MC_DASH_BACKEND_URL
# at container start, so one published image serves any backend port.
ARG NEXT_PUBLIC_API_BASE_URL=/api
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN npm run build

# --- Runtime stage ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy the whole built app (node_modules, .next, package.json) so `next start`
# has everything it needs regardless of whether a public/ dir exists.
COPY --from=build /app ./

EXPOSE 3000
# Compose supplies the production bind address, port and backend URL.
CMD ["node", "start.mjs"]
