# 15-web-analytics — self-hosted, single-process container.
#
# Build:   docker build -t 15-web-analytics .
# Run:     docker run -d -p 8787:8787 \
#            -v analytics-data:/data \
#            -e WA_HOST=0.0.0.0 \
#            -e WA_DATA_DIR=/data \
#            15-web-analytics
#
# Node 22 ships the experimental-but-stable `node:sqlite`, so no native
# build step or external services are required.

FROM node:22-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code + static dashboard.
COPY src ./src
COPY public ./public

# The license text rides along with every distributed copy.
COPY LICENSE ./
COPY COMMERCIAL-LICENSE.md ./

ENV NODE_ENV=production \
    WA_HOST=0.0.0.0 \
    WA_PORT=8787 \
    WA_DATA_DIR=/data

# /data is created and owned by `node` in the image so that Docker named
# volumes initialized from this image (which copy ownership, not just files)
# inherit the writable layout. Otherwise a fresh volume is root-owned and the
# runtime `mkdir -p` under USER node fails with EACCES.
RUN mkdir -p /data && chown node:node /data

VOLUME /data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1

USER node

CMD ["sh", "-c", "mkdir -p \"$WA_DATA_DIR\" && node --disable-warning=ExperimentalWarning src/server.js"]
