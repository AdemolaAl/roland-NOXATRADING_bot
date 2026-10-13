# Multi-stage build for the NOXATRADING Telegram bot.
# Railway auto-detects this Dockerfile and uses it directly, bypassing
# railpack's heuristic which mis-classifies the project as a Vite static site.

# ─── build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Install ALL deps (incl. dev) for the typescript compile.
COPY package*.json ./
RUN npm ci

# Copy only what's needed to compile.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build

# ─── runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Production-only deps. node-pg-migrate is in `dependencies`, so the migrate
# script in `npm run db:migrate` works at runtime.
COPY package*.json ./
RUN npm ci --omit=dev

# Compiled JS, migrations, and the image assets the bot serves at
# runtime via sendPhoto (welcome banner, signal banners, etc.).
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY scripts ./scripts
COPY images ./images

EXPOSE 3000

# Apply pending migrations, then start the long-running bot. `sh -c` so the
# `&&` chains correctly inside the single CMD entrypoint.
CMD ["sh", "-c", "npm run db:migrate && npm start"]
