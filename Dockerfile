# Periscope API, hosted. One container: the coordinator, the Steel session pool, the SQLite store, the model calls.
# Browsers run on Steel's cloud; this image only needs Node. Data (SQLite, screenshots, briefs) lives under /data:
# mount a volume there so runs survive a redeploy.
FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
COPY . .
ENV NODE_ENV=production
ENV PERISCOPE_DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 4747
CMD ["npx", "tsx", "src/api/main.ts"]
