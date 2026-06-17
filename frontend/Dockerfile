# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* vars are inlined into the client bundle at build time, so the
# browser-facing backend URL must be supplied here (not at runtime). Point this
# at the address browsers will use to reach the backend, e.g.
# http://<your-lan-ip>:4000
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
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
# next start binds 0.0.0.0 so it is reachable across the LAN.
CMD ["npm", "run", "start"]
