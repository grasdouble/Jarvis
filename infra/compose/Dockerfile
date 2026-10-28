FROM node:24.22.0-bookworm-slim@sha256:156e9bc7a0a267cc6ca77b4283e32b123479342df684ce297455d7b95ff5a6b5 AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @jarvis/api run build && pnpm --filter @jarvis/web run build
RUN pnpm install --prod --frozen-lockfile

FROM node:24.22.0-bookworm-slim@sha256:156e9bc7a0a267cc6ca77b4283e32b123479342df684ce297455d7b95ff5a6b5
ENV NODE_ENV=production WEB_ROOT=/app/apps/web/dist
WORKDIR /app
COPY --from=build /workspace/ ./
USER 0:0
EXPOSE 3000
ENTRYPOINT ["node", "/app/apps/api/dist/main.js"]
