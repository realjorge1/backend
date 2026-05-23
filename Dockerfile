# syntax=docker/dockerfile:1.6
#
# Inscribed backend — Node + LibreOffice image for Render.com deploy.
# LibreOffice Impress is what backs /api/pptx/convert (PPTX → PDF).

# ─── Build stage: install node_modules with native build tools ───────────────
FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# ─── Runtime stage: LibreOffice + fonts, no build tools ──────────────────────
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      libreoffice-writer \
      fonts-liberation \
      fonts-dejavu-core \
      fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=10000 \
    HOST=0.0.0.0

EXPOSE 10000

CMD ["node", "src/server.js"]
