FROM node:24.22.0-bookworm-slim@sha256:156e9bc7a0a267cc6ca77b4283e32b123479342df684ce297455d7b95ff5a6b5

ENV NODE_ENV=production
WORKDIR /app
COPY apps/sandbox-manager/dist/ ./dist/
USER 10001:10001
ENTRYPOINT ["node", "/app/dist/main.js"]
