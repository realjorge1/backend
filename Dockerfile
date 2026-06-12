# syntax=docker/dockerfile:1.6
#
# Inscribed backend — Node + LibreOffice image for Render.com deploy.
# LibreOffice Impress is what backs /api/pptx/convert (PPTX → PDF);
# Writer/Calc back /api/convert/word-to-pdf and /api/convert/excel-to-pdf.

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

# Fonts: Carlito/Caladea are metric-compatible with Calibri/Cambria (the
# PowerPoint defaults), Liberation covers Arial/Times/Courier, Noto for broad
# unicode coverage. qpdf/ghostscript/graphicsmagick back the PDF repair,
# encryption, and pdf2pic rasterization paths; poppler-utils provides
# pdftoppm for slide-image rendering.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      libreoffice-writer \
      libreoffice-calc \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-liberation \
      fonts-dejavu-core \
      fonts-noto-core \
      fontconfig \
      qpdf \
      ghostscript \
      graphicsmagick \
      poppler-utils \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=10000 \
    HOST=0.0.0.0 \
    LIBREOFFICE_PATH=/usr/bin/soffice

EXPOSE 10000

CMD ["node", "src/server.js"]
