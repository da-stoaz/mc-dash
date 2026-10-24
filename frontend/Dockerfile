# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# The browser uses /api; Next proxies it to the backend. Both are build inputs.
ARG NEXT_PUBLIC_API_BASE_URL=/api
ARG MC_DASH_BACKEND_URL=http://127.0.0.1:4000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV MC_DASH_BACKEND_URL=$MC_DASH_BACKEND_URL
RUN npm run build

# --- Runtime stage ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy the whole built app (node_modules, .next, package.json) so `next start`
# has everything it needs regardless of whether a public/ dir exists.
COPY --from=build /app ./

EXPOSE 3000
# Compose supplies the production bind address and port.
CMD ["npm", "run", "start"]
