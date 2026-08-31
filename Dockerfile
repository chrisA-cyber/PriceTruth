# syntax=docker/dockerfile:1.7
FROM node:26.8.1-alpine AS production

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4780 \
    PRICETRUTH_DB=/var/lib/pricetruth/pricetruth.db

WORKDIR /app

# Production remains zero-runtime-dependency. npm ci still verifies the lockfile
# and package metadata, while --ignore-scripts blocks supply-chain hooks.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --chown=10001:10001 src ./src
COPY --chown=10001:10001 public ./public
COPY --chown=10001:10001 extension ./extension
COPY --chown=10001:10001 openapi ./openapi
COPY --chown=10001:10001 package.json README.md CONTRACTS.md ./

RUN mkdir -p /var/lib/pricetruth && chown -R 10001:10001 /var/lib/pricetruth /app

USER 10001:10001
EXPOSE 4780
VOLUME ["/var/lib/pricetruth"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4780/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "src/server.js"]
