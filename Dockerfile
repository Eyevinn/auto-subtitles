ARG NODE_IMAGE=node:20-alpine

# ---- Build stage ----
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

COPY package.json package-lock.json* tsconfig*.json ./
# Delete prepare script to avoid errors from husky
RUN npm pkg delete scripts.prepare \
    && npm ci

COPY src/ ./src/
RUN npm run build

# ---- Production stage ----
FROM ${NODE_IMAGE} AS production

RUN apk update && apk add --no-cache ffmpeg tini \
    && rm -rf /var/cache/apk/*

ENV NODE_ENV=production
ENV STAGING_DIR=/usercontent

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm pkg delete scripts.prepare \
    && npm ci --omit=dev \
    && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p /usercontent && chown node:node /usercontent

USER node

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8000/ || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npm", "run", "start"]
