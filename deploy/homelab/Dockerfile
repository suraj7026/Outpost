FROM node:24-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY server ./server
RUN npm run build
ENV NODE_ENV=production OUTPOST_DATA=/data HOME=/tmp
USER node
CMD ["node", "--import", "tsx", "server/main.ts"]
