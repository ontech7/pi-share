# syntax=docker/dockerfile:1.7
FROM node:25-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 has no prebuilt binary for every platform (arm64 included): compile it here, not in the final image
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:25-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/src/shared ./src/shared
USER 10001:10001
CMD ["node", "src/server/bin/admin.ts"]
